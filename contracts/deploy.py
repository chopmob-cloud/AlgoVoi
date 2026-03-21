"""
Deploy SpendingCapVault to Algorand mainnet and/or Voi mainnet.

Usage:
    python deploy.py --chain algorand
    python deploy.py --chain voi
    python deploy.py --chain both

Prerequisites:
    pip install algorand-python algokit-utils algosdk python-dotenv
    algokit compile spending_cap.py   # produces spending_cap.arc32.json

Environment (.env):
    OWNER_MNEMONIC=<25-word mnemonic of your owner wallet>
    AGENT_ADDRESS=<Algorand address of the AI agent key>

    # Global fallback spending limits (in base units — microALGO or microVOI)
    MAX_PER_TXN=1000000          # 1 ALGO/VOI per payment (default for all agents)
    DAILY_CAP=10000000           # 10 ALGO/VOI per day (default for all agents)
    MAX_ASA_PER_TXN=1000000      # 1 USDC/aUSDC per pay_asa() call
    ALLOWLIST_ENABLED=0          # 0 = open, 1 = allowlist enforced

    # First agent limits (0 = inherit global defaults)
    AGENT_MAX_PER_TXN=0
    AGENT_DAILY_CAP=0

    # Optional: fund vault on deploy
    INITIAL_FUND_MICROALGOS=5000000  # 5 ALGO/VOI seed
"""

import argparse
import json
import os
from pathlib import Path

from algosdk import mnemonic, transaction
from algosdk.v2client import algod
from algokit_utils import (
    ApplicationClient,
    ApplicationSpecification,
    Account,
)
from dotenv import load_dotenv

load_dotenv()

# ── Chain configs ─────────────────────────────────────────────────────────────

CHAINS = {
    "algorand": {
        "algod_url":   "https://mainnet-api.algonode.cloud",
        "algod_token": "",
        "label":       "Algorand mainnet",
    },
    "voi": {
        "algod_url":   "https://mainnet-api.voi.nodely.dev",
        "algod_token": "",
        "label":       "Voi mainnet",
    },
}

# ── ARC-32 spec (compiled by: algokit compile spending_cap.py) ────────────────

ARC32_PATH = Path(__file__).parent / "spending_cap.arc32.json"


def load_spec() -> ApplicationSpecification:
    if not ARC32_PATH.exists():
        raise FileNotFoundError(
            f"Compiled spec not found: {ARC32_PATH}\n"
            "Run:  algokit compile spending_cap.py"
        )
    return ApplicationSpecification.from_json(ARC32_PATH.read_text())


# ── Deployment ────────────────────────────────────────────────────────────────

def deploy_to_chain(chain_name: str) -> dict:
    cfg = CHAINS[chain_name]
    print(f"\n{'='*60}")
    print(f"  Deploying to {cfg['label']}")
    print(f"{'='*60}")

    # Load keys
    owner_mnemonic = os.environ["OWNER_MNEMONIC"]
    owner_sk       = mnemonic.to_private_key(owner_mnemonic)
    owner_address  = mnemonic.to_public_key(owner_mnemonic)
    agent_address  = os.environ["AGENT_ADDRESS"]

    # Global fallback limits
    max_per_txn     = int(os.environ.get("MAX_PER_TXN",     "1000000"))
    daily_cap       = int(os.environ.get("DAILY_CAP",       "10000000"))
    max_asa_per_txn = int(os.environ.get("MAX_ASA_PER_TXN", "1000000"))
    allowlist_on    = int(os.environ.get("ALLOWLIST_ENABLED", "0"))

    # First agent's custom limits (0 = use global defaults above)
    agent_max_per_txn = int(os.environ.get("AGENT_MAX_PER_TXN", "0"))
    agent_daily_cap   = int(os.environ.get("AGENT_DAILY_CAP",   "0"))

    print(f"  Owner:              {owner_address}")
    print(f"  First agent:        {agent_address}")
    print(f"  global max_per_txn: {max_per_txn / 1e6:.4f}")
    print(f"  global daily_cap:   {daily_cap / 1e6:.4f}")
    print(f"  global max_asa:     {max_asa_per_txn / 1e6:.4f}")
    print(f"  allowlist:          {'enabled' if allowlist_on else 'disabled'}")
    if agent_max_per_txn or agent_daily_cap:
        print(f"  agent max_per_txn:  {agent_max_per_txn / 1e6:.4f} (custom)")
        print(f"  agent daily_cap:    {agent_daily_cap / 1e6:.4f} (custom)")
    else:
        print(f"  agent limits:       inherits global defaults")

    # Connect
    client        = algod.AlgodClient(cfg["algod_token"], cfg["algod_url"])
    owner_account = Account(private_key=owner_sk)

    # Deploy — create() takes only global limits now; agents added via add_agent()
    app_client = ApplicationClient(
        algod_client=client,
        app=load_spec(),
        signer=owner_account,
    )

    app_id, app_address, tx_id = app_client.create(
        call_abi_method="create",
        global_max_per_txn=max_per_txn,
        global_daily_cap=daily_cap,
        global_max_asa_per_txn=max_asa_per_txn,
        allowlist_enabled=allowlist_on,
    )

    print(f"\n  ✓ Deployed!")
    print(f"  App ID:      {app_id}")
    print(f"  App address: {app_address}")
    print(f"  Tx:          {tx_id}")

    # Fund vault (required before add_agent box creation)
    initial_fund = int(os.environ.get("INITIAL_FUND_MICROALGOS", "0"))
    if initial_fund > 0:
        params  = client.suggested_params()
        fund_tx = transaction.PaymentTxn(
            sender=owner_address,
            sp=params,
            receiver=app_address,
            amt=initial_fund,
        )
        signed     = fund_tx.sign(owner_sk)
        fund_tx_id = client.send_transaction(signed)
        transaction.wait_for_confirmation(client, fund_tx_id, 4)
        print(f"  ✓ Funded with {initial_fund / 1e6:.4f} — tx: {fund_tx_id}")
    else:
        print(f"\n  ⚠  Vault not funded. Fund it before calling add_agent():")
        print(f"     Send ≥0.2 ALGO/VOI to {app_address}")

    # Register the first agent
    add_tx_id = app_client.call(
        call_abi_method="add_agent",
        agent=agent_address,
        max_per_txn=agent_max_per_txn,
        daily_cap=agent_daily_cap,
    ).tx_id
    print(f"  ✓ Agent registered: {agent_address[:20]}… — tx: {add_tx_id}")

    return {
        "chain":       chain_name,
        "app_id":      app_id,
        "app_address": app_address,
        "deploy_tx":   tx_id,
        "agents":      [agent_address],
    }


def main():
    parser = argparse.ArgumentParser(description="Deploy SpendingCapVault")
    parser.add_argument(
        "--chain",
        choices=["algorand", "voi", "both"],
        default="both",
        help="Target chain(s)",
    )
    args = parser.parse_args()

    chains  = ["algorand", "voi"] if args.chain == "both" else [args.chain]
    results = []

    for chain in chains:
        result = deploy_to_chain(chain)
        results.append(result)

    # Save deployment record
    output_path = Path(__file__).parent / "deployments.json"
    existing    = json.loads(output_path.read_text()) if output_path.exists() else []
    existing.extend(results)
    output_path.write_text(json.dumps(existing, indent=2))

    print(f"\n{'='*60}")
    print("  Deployment summary")
    print(f"{'='*60}")
    for r in results:
        print(f"  {r['chain']:10} app_id={r['app_id']}  address={r['app_address']}")
    print(f"\n  Saved to {output_path}")
    print("\n  Next steps:")
    print("  1. Add more agents:    python deploy.py (or app_client.call('add_agent', ...))")
    print("  2. Add recipients:     app_client.call('add_recipient', recipient=<address>, ...)")
    print("  3. Opt into ASAs:      app_client.call('opt_in_asa', asset=<asa_id>)")
    print("  4. Top up vault:       send ALGO/VOI to the app address above")
    print("  5. Run agent:          python agent.py --chain algorand --status")


if __name__ == "__main__":
    main()
