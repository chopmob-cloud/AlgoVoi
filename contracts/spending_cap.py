"""
SpendingCapVault — AVM Smart Contract for AI Agent Autonomous Payments

Deploys identically to Algorand mainnet and Voi mainnet (same AVM bytecode).

Architecture:
  owner        — human wallet; full admin control, cannot be changed post-deploy
  agents       — BoxMap of authorised AI agents, each with independent limits
  recipients   — BoxMap of per-recipient limits (optional; doubles as allowlist)

Limit resolution (per payment):
  1. Agent check    — sender must be a registered, enabled agent
  2. Agent limits   — agent's own max_per_txn + daily_cap enforced
  3. Recipient check — if allowlist_enabled=1, recipient must have a config entry
  4. Recipient limits — recipient's own max_per_txn + daily_cap enforced
  Both limits must pass — whichever is tighter wins.

Box storage MBR (pre-fund the vault before adding agents/recipients):
  Per agent entry:    ~0.033 ALGO
  Per recipient entry: ~0.030 ALGO

Compile:  algokit compile python spending_cap.py  # targets AVM 10 (avm_version=10 on class)
Deploy:   python deploy.py --chain both
Agent:    python agent.py --chain algorand --status
"""

from algopy import (
    ARC4Contract,
    Account,
    Asset,
    BoxMap,
    Global,
    GlobalState,
    Txn,
    UInt64,
    arc4,
    itxn,
    subroutine,
)


# ── Structs (ABI-encoded, stored in boxes) ────────────────────────────────────

class AgentConfig(arc4.Struct):
    """Per-agent configuration and independent spend tracking."""
    enabled:     arc4.UInt64  # 1 = active, 0 = suspended
    max_per_txn: arc4.UInt64  # max native coin per call; 0 = use global default
    daily_cap:   arc4.UInt64  # max native coin per UTC day; 0 = use global default
    day_bucket:  arc4.UInt64  # floor(unix_timestamp / 86400) — current day
    day_spent:   arc4.UInt64  # native coin spent in current day_bucket


class RecipientConfig(arc4.Struct):
    """Per-recipient limits and independent spend tracking."""
    max_per_txn: arc4.UInt64  # max native coin per payment to this address; 0 = global
    daily_cap:   arc4.UInt64  # max native coin per day to this address; 0 = global
    day_bucket:  arc4.UInt64  # current day for this recipient
    day_spent:   arc4.UInt64  # spent to this recipient today


# ── Contract ──────────────────────────────────────────────────────────────────

class SpendingCapVault(ARC4Contract, avm_version=10):
    """Multi-agent spending cap vault. Same bytecode on Algorand and Voi."""

    def __init__(self) -> None:
        # Owner (immutable after creation)
        self.owner = GlobalState(Account, key="owner")

        # Global fallback limits (used when agent/recipient has no custom limit)
        self.global_max_per_txn    = GlobalState(UInt64, key="g_max_txn")
        self.global_daily_cap      = GlobalState(UInt64, key="g_daily_cap")
        self.global_max_asa_per_txn = GlobalState(UInt64, key="g_max_asa")

        # Allowlist mode: 0 = any recipient allowed, 1 = must have RecipientConfig entry
        self.allowlist_enabled = GlobalState(UInt64, key="al_enabled")

        # Vault-wide audit counters
        self.total_paid     = GlobalState(UInt64, key="total_paid")
        self.total_paid_asa = GlobalState(UInt64, key="total_asa")
        self.tx_count       = GlobalState(UInt64, key="tx_count")

        # Box storage — agent address → AgentConfig
        self.agents = BoxMap(arc4.Address, AgentConfig, key_prefix=b"ag_")

        # Box storage — recipient address → RecipientConfig
        # Also serves as the allowlist when allowlist_enabled=1
        self.recipients = BoxMap(arc4.Address, RecipientConfig, key_prefix=b"rc_")

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    @arc4.abimethod(create="require")
    def create(
        self,
        global_max_per_txn:    arc4.UInt64,
        global_daily_cap:      arc4.UInt64,
        global_max_asa_per_txn: arc4.UInt64,
        allowlist_enabled:     arc4.UInt64,
    ) -> None:
        """
        Deploy the vault. No agents are added yet — use add_agent() after deployment.

        Args:
            global_max_per_txn:     Default max native coin per payment (micro-units)
            global_daily_cap:       Default max native coin per UTC day (micro-units)
            global_max_asa_per_txn: Default max ASA base units per pay_asa()
            allowlist_enabled:      1 = only registered recipients allowed, 0 = open
        """
        self.owner.value                = Txn.sender
        self.global_max_per_txn.value   = global_max_per_txn.native
        self.global_daily_cap.value     = global_daily_cap.native
        self.global_max_asa_per_txn.value = global_max_asa_per_txn.native
        self.allowlist_enabled.value    = allowlist_enabled.native
        self.total_paid.value           = UInt64(0)
        self.total_paid_asa.value       = UInt64(0)
        self.tx_count.value             = UInt64(0)

    # ── Internal helpers ───────────────────────────────────────────────────────

    @subroutine
    def _effective_limit(self, specific: UInt64, global_default: UInt64) -> UInt64:
        """Return specific limit if non-zero, else fall back to global default."""
        if specific > UInt64(0):
            return specific
        return global_default

    @subroutine
    def _check_and_update_agent(
        self, agent_addr: arc4.Address, amount: UInt64
    ) -> None:
        """
        Validate agent is enabled and within its limits; update agent's daily spend.
        Modifies box storage in place (copy → mutate → write back).
        """
        assert agent_addr in self.agents, "Agent not registered"
        cfg = self.agents[agent_addr].copy()

        assert cfg.enabled.native == UInt64(1), "Agent is suspended"

        # Effective max per txn for this agent
        eff_max = self._effective_limit(
            cfg.max_per_txn.native, self.global_max_per_txn.value
        )
        assert amount <= eff_max, "Exceeds agent max_per_txn"

        # Reset daily bucket if UTC day has rolled over
        current_bucket = Global.latest_timestamp // UInt64(86400)
        if current_bucket > cfg.day_bucket.native:
            cfg.day_bucket = arc4.UInt64(current_bucket)
            cfg.day_spent  = arc4.UInt64(0)

        # Effective daily cap for this agent
        eff_cap = self._effective_limit(
            cfg.daily_cap.native, self.global_daily_cap.value
        )
        assert cfg.day_spent.native + amount <= eff_cap, "Agent daily cap exceeded"

        # Update spend and write back
        cfg.day_spent = arc4.UInt64(cfg.day_spent.native + amount)
        self.agents[agent_addr] = cfg.copy()

    @subroutine
    def _check_and_update_recipient(
        self, recipient_addr: arc4.Address, amount: UInt64
    ) -> None:
        """
        If recipient has a config: validate limits and update spend tracking.
        If allowlist_enabled=1 and no config: this should already be caught upstream.
        """
        if recipient_addr in self.recipients:
            cfg = self.recipients[recipient_addr].copy()

            eff_max = self._effective_limit(
                cfg.max_per_txn.native, self.global_max_per_txn.value
            )
            assert amount <= eff_max, "Exceeds recipient max_per_txn"

            current_bucket = Global.latest_timestamp // UInt64(86400)
            if current_bucket > cfg.day_bucket.native:
                cfg.day_bucket = arc4.UInt64(current_bucket)
                cfg.day_spent  = arc4.UInt64(0)

            eff_cap = self._effective_limit(
                cfg.daily_cap.native, self.global_daily_cap.value
            )
            assert cfg.day_spent.native + amount <= eff_cap, "Recipient daily cap exceeded"

            cfg.day_spent = arc4.UInt64(cfg.day_spent.native + amount)
            self.recipients[recipient_addr] = cfg.copy()

    # ── Agent: native coin payment ─────────────────────────────────────────────

    @arc4.abimethod
    def pay(
        self,
        receiver: arc4.Address,
        amount:   arc4.UInt64,
        note:     arc4.String,
    ) -> None:
        """
        Pay ALGO/VOI to receiver. Any registered, enabled agent may call this.

        Enforces (in order):
          1. Agent must be registered and enabled
          2. Amount ≤ agent's effective max_per_txn
          3. Agent's effective daily_cap not exceeded
          4. If allowlist_enabled=1: receiver must have a RecipientConfig entry
          5. Amount ≤ recipient's effective max_per_txn (if config exists)
          6. Recipient's effective daily_cap not exceeded (if config exists)
        """
        native_amount   = amount.native
        agent_addr      = arc4.Address(Txn.sender.bytes)

        assert native_amount > UInt64(0), "Amount must be > 0"

        # Agent checks + update
        self._check_and_update_agent(agent_addr, native_amount)

        # Allowlist check
        if self.allowlist_enabled.value == UInt64(1):
            assert receiver in self.recipients, "Recipient not in allowlist"

        # Per-recipient checks + update
        self._check_and_update_recipient(receiver, native_amount)

        # Vault-wide counters
        self.total_paid.value = self.total_paid.value + native_amount
        self.tx_count.value   = self.tx_count.value + UInt64(1)

        itxn.Payment(
            receiver=Account(receiver.bytes),
            amount=native_amount,
            note=note.bytes,
            fee=Global.min_txn_fee,
        ).submit()

    # ── Agent: ASA transfer ────────────────────────────────────────────────────

    @arc4.abimethod
    def pay_asa(
        self,
        receiver: arc4.Address,
        asset:    Asset,
        amount:   arc4.UInt64,
        note:     arc4.String,
    ) -> None:
        """
        Transfer ASA (USDC / aUSDC) to receiver. Any registered, enabled agent may call.
        Uses global_max_asa_per_txn as the limit (no per-recipient ASA cap in this version).
        """
        native_amount = amount.native
        agent_addr    = arc4.Address(Txn.sender.bytes)

        assert native_amount > UInt64(0), "Amount must be > 0"
        assert native_amount <= self.global_max_asa_per_txn.value, "Exceeds max_asa_per_txn"

        # Agent must be registered and enabled (no daily cap applied to ASA — separate concern)
        assert agent_addr in self.agents, "Agent not registered"
        cfg = self.agents[agent_addr].copy()
        assert cfg.enabled.native == UInt64(1), "Agent is suspended"

        if self.allowlist_enabled.value == UInt64(1):
            assert receiver in self.recipients, "Recipient not in allowlist"

        self.total_paid_asa.value = self.total_paid_asa.value + native_amount
        self.tx_count.value       = self.tx_count.value + UInt64(1)

        itxn.AssetTransfer(
            xfer_asset=asset,
            asset_receiver=Account(receiver.bytes),
            asset_amount=native_amount,
            note=note.bytes,
            fee=Global.min_txn_fee,
        ).submit()

    # ── Owner: agent management ────────────────────────────────────────────────

    @arc4.abimethod
    def add_agent(
        self,
        agent:       arc4.Address,
        max_per_txn: arc4.UInt64,
        daily_cap:   arc4.UInt64,
    ) -> None:
        """
        Register a new agent. Set max_per_txn=0 and/or daily_cap=0 to use global defaults.
        Overwrites existing config if agent already registered.

        Note: caller must fund the vault for the box MBR (~0.033 ALGO per agent).
        """
        assert Txn.sender == self.owner.value, "Only owner"
        self.agents[agent] = AgentConfig(
            enabled     = arc4.UInt64(1),
            max_per_txn = max_per_txn,
            daily_cap   = daily_cap,
            day_bucket  = arc4.UInt64(Global.latest_timestamp // UInt64(86400)),
            day_spent   = arc4.UInt64(0),
        )

    @arc4.abimethod
    def update_agent(
        self,
        agent:       arc4.Address,
        max_per_txn: arc4.UInt64,
        daily_cap:   arc4.UInt64,
    ) -> None:
        """Update an existing agent's limits without resetting spend counters."""
        assert Txn.sender == self.owner.value, "Only owner"
        assert agent in self.agents, "Agent not registered"
        cfg = self.agents[agent].copy()
        cfg.max_per_txn = max_per_txn
        cfg.daily_cap   = daily_cap
        self.agents[agent] = cfg.copy()

    @arc4.abimethod
    def suspend_agent(self, agent: arc4.Address) -> None:
        """Immediately block an agent from making payments (e.g. key compromise)."""
        assert Txn.sender == self.owner.value, "Only owner"
        assert agent in self.agents, "Agent not registered"
        cfg = self.agents[agent].copy()
        cfg.enabled = arc4.UInt64(0)
        self.agents[agent] = cfg.copy()

    @arc4.abimethod
    def resume_agent(self, agent: arc4.Address) -> None:
        """Re-enable a suspended agent."""
        assert Txn.sender == self.owner.value, "Only owner"
        assert agent in self.agents, "Agent not registered"
        cfg = self.agents[agent].copy()
        cfg.enabled = arc4.UInt64(1)
        self.agents[agent] = cfg.copy()

    @arc4.abimethod
    def remove_agent(self, agent: arc4.Address) -> None:
        """Remove an agent entirely and reclaim box MBR."""
        assert Txn.sender == self.owner.value, "Only owner"
        if agent in self.agents:
            del self.agents[agent]

    # ── Owner: recipient management ────────────────────────────────────────────

    @arc4.abimethod
    def add_recipient(
        self,
        recipient:   arc4.Address,
        max_per_txn: arc4.UInt64,
        daily_cap:   arc4.UInt64,
    ) -> None:
        """
        Add or update a recipient config. Set limits to 0 to use global defaults.
        When allowlist_enabled=1, any recipient not in this map is blocked.

        Note: caller must fund the vault for the box MBR (~0.030 ALGO per recipient).
        """
        assert Txn.sender == self.owner.value, "Only owner"
        self.recipients[recipient] = RecipientConfig(
            max_per_txn = max_per_txn,
            daily_cap   = daily_cap,
            day_bucket  = arc4.UInt64(Global.latest_timestamp // UInt64(86400)),
            day_spent   = arc4.UInt64(0),
        )

    @arc4.abimethod
    def update_recipient(
        self,
        recipient:   arc4.Address,
        max_per_txn: arc4.UInt64,
        daily_cap:   arc4.UInt64,
    ) -> None:
        """Update recipient limits without resetting spend counters."""
        assert Txn.sender == self.owner.value, "Only owner"
        assert recipient in self.recipients, "Recipient not registered"
        cfg = self.recipients[recipient].copy()
        cfg.max_per_txn = max_per_txn
        cfg.daily_cap   = daily_cap
        self.recipients[recipient] = cfg.copy()

    @arc4.abimethod
    def remove_recipient(self, recipient: arc4.Address) -> None:
        """Remove a recipient config and reclaim box MBR."""
        assert Txn.sender == self.owner.value, "Only owner"
        if recipient in self.recipients:
            del self.recipients[recipient]

    # ── Owner: global config ───────────────────────────────────────────────────

    @arc4.abimethod
    def update_global_limits(
        self,
        max_per_txn:    arc4.UInt64,
        daily_cap:      arc4.UInt64,
        max_asa_per_txn: arc4.UInt64,
    ) -> None:
        """Update global fallback limits (affects agents/recipients with 0 custom limits)."""
        assert Txn.sender == self.owner.value, "Only owner"
        self.global_max_per_txn.value    = max_per_txn.native
        self.global_daily_cap.value      = daily_cap.native
        self.global_max_asa_per_txn.value = max_asa_per_txn.native

    @arc4.abimethod
    def set_allowlist_enabled(self, enabled: arc4.UInt64) -> None:
        """Toggle recipient allowlist enforcement."""
        assert Txn.sender == self.owner.value, "Only owner"
        self.allowlist_enabled.value = enabled.native

    # ── Owner: fund management ─────────────────────────────────────────────────

    @arc4.abimethod
    def owner_withdraw(self, receiver: arc4.Address, amount: arc4.UInt64) -> None:
        """Owner withdraws native coin from vault."""
        assert Txn.sender == self.owner.value, "Only owner"
        itxn.Payment(
            receiver=Account(receiver.bytes),
            amount=amount.native,
            fee=Global.min_txn_fee,
        ).submit()

    @arc4.abimethod
    def owner_withdraw_asa(
        self, receiver: arc4.Address, asset: Asset, amount: arc4.UInt64
    ) -> None:
        """Owner withdraws ASA from vault."""
        assert Txn.sender == self.owner.value, "Only owner"
        itxn.AssetTransfer(
            xfer_asset=asset,
            asset_receiver=Account(receiver.bytes),
            asset_amount=amount.native,
            fee=Global.min_txn_fee,
        ).submit()

    @arc4.abimethod
    def opt_in_asa(self, asset: Asset) -> None:
        """Opt the vault account into an ASA before first pay_asa(). Owner only."""
        assert Txn.sender == self.owner.value, "Only owner"
        itxn.AssetTransfer(
            xfer_asset=asset,
            asset_receiver=Global.current_application_address,
            asset_amount=UInt64(0),
            fee=Global.min_txn_fee,
        ).submit()

    # ── Read-only queries ──────────────────────────────────────────────────────

    @arc4.abimethod(readonly=True)
    def get_global_state(self) -> arc4.Tuple[
        arc4.UInt64,  # global_max_per_txn
        arc4.UInt64,  # global_daily_cap
        arc4.UInt64,  # global_max_asa_per_txn
        arc4.UInt64,  # allowlist_enabled
        arc4.UInt64,  # total_paid
        arc4.UInt64,  # total_paid_asa
        arc4.UInt64,  # tx_count
    ]:
        """Global vault state — simulate, no fee."""
        return arc4.Tuple((
            arc4.UInt64(self.global_max_per_txn.value),
            arc4.UInt64(self.global_daily_cap.value),
            arc4.UInt64(self.global_max_asa_per_txn.value),
            arc4.UInt64(self.allowlist_enabled.value),
            arc4.UInt64(self.total_paid.value),
            arc4.UInt64(self.total_paid_asa.value),
            arc4.UInt64(self.tx_count.value),
        ))

    @arc4.abimethod(readonly=True)
    def get_agent_state(self, agent: arc4.Address) -> AgentConfig:
        """Return the AgentConfig for a given agent address — simulate, no fee."""
        assert agent in self.agents, "Agent not registered"
        return self.agents[agent].copy()

    @arc4.abimethod(readonly=True)
    def get_recipient_state(self, recipient: arc4.Address) -> RecipientConfig:
        """Return the RecipientConfig for a given recipient — simulate, no fee."""
        assert recipient in self.recipients, "Recipient not registered"
        return self.recipients[recipient].copy()
