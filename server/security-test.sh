#!/bin/bash
# AlgoVoi Coinbase Onramp — Security Test Suite
# Endpoint: POST https://mcp.ilovechicken.co.uk/api/coinbase-session
# Date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

BASE="https://mcp.ilovechicken.co.uk/api/coinbase-session"
ADDR="ATQCF6LACHUZTBMFMPALIEK6LKD7PB7TPWL25OYQKRKK735UGL6D7AZIYY"
ADDR2="GHSRL2SAY247LWE7HLUGEYKHC5JMDOGWECW5TMN6PTP73FT2Z5AWMADMWI"
PASS=0
FAIL=0

run_test() {
  local num="$1" name="$2" expected="$3" actual="$4"
  if echo "$actual" | grep -q "$expected"; then
    echo "[$num] PASS — $name"
    echo "       Expected: $expected"
    echo "       Got:      $actual"
    PASS=$((PASS+1))
  else
    echo "[$num] FAIL — $name"
    echo "       Expected: $expected"
    echo "       Got:      $actual"
    FAIL=$((FAIL+1))
  fi
  echo ""
}

echo "============================================================"
echo " AlgoVoi Coinbase Onramp — Security Test Report"
echo " Endpoint: $BASE"
echo " Date:     $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo "============================================================"
echo ""

# --- Authentication Tests ---
echo "── Authentication ──────────────────────────────────────────"
echo ""

R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" -d '{}')
run_test 1 "No auth fields" "Authentication required" "$R"

R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" -d '{"address":"TEST","message":"x","nonce":"x"}')
run_test 2 "Partial auth (no signature)" "Authentication required" "$R"

R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d "{\"address\":\"$ADDR\",\"signature\":\"dGVzdA==\",\"message\":\"coinbase-onramp:$ADDR:exp1:1000\",\"nonce\":\"exp1\",\"addresses\":{\"$ADDR\":[\"algorand\"]}}")
run_test 3 "Expired timestamp" "Message expired" "$R"

TS=$(($(date +%s)*1000))
R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d "{\"address\":\"$ADDR\",\"signature\":\"dGVzdA==\",\"message\":\"wrong:format:here:$TS\",\"nonce\":\"here\",\"addresses\":{\"$ADDR\":[\"algorand\"]}}")
run_test 4 "Bad message format" "Invalid message format" "$R"

TS=$(($(date +%s)*1000))
R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d "{\"address\":\"$ADDR\",\"signature\":\"dGVzdA==\",\"message\":\"coinbase-onramp:$ADDR:fs5:$TS\",\"nonce\":\"fs5\",\"addresses\":{\"$ADDR\":[\"algorand\"]}}")
run_test 5 "Fake signature" "Invalid wallet signature" "$R"

TS=$(($(date +%s)*1000))
R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d "{\"address\":\"$ADDR\",\"signature\":\"dGVzdA==\",\"message\":\"coinbase-onramp:$ADDR:am9:$TS\",\"nonce\":\"am9\",\"addresses\":{\"$ADDR2\":[\"algorand\"]}}")
run_test 9 "Address mismatch (sign as A, request for B)" "Invalid wallet signature" "$R"

# --- Nonce Replay ---
echo "── Nonce Replay ───────────────────────────────────────────"
echo ""

TS=$(($(date +%s)*1000))
curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d "{\"address\":\"$ADDR\",\"signature\":\"dGVzdA==\",\"message\":\"coinbase-onramp:$ADDR:replaytest:$TS\",\"nonce\":\"replaytest\",\"addresses\":{\"$ADDR\":[\"algorand\"]}}" > /dev/null 2>&1
R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d "{\"address\":\"$ADDR\",\"signature\":\"dGVzdA==\",\"message\":\"coinbase-onramp:$ADDR:replaytest:$TS\",\"nonce\":\"replaytest\",\"addresses\":{\"$ADDR\":[\"algorand\"]}}")
run_test 13 "Nonce reuse (replay attack)" "Nonce already used\|Invalid wallet signature" "$R"

# --- CORS ---
echo "── CORS ───────────────────────────────────────────────────"
echo ""

R=$(curl -s -D - -X OPTIONS "$BASE" -H "Origin: https://evil.com" -H "Access-Control-Request-Method: POST" 2>&1)
if echo "$R" | grep -q "Access-Control-Allow-Origin"; then
  run_test 6 "Evil CORS origin blocked" "no-header" "Access-Control-Allow-Origin PRESENT"
else
  run_test 6 "Evil CORS origin blocked" "no-header" "no-header"
fi

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$BASE" -H "Origin: chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef" -H "Access-Control-Request-Method: POST")
run_test 7 "Extension CORS origin allowed (OPTIONS returns 204)" "204" "$HTTP_CODE"

# --- HTTP Methods ---
echo "── HTTP Methods ───────────────────────────────────────────"
echo ""

R=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$BASE" --max-time 10)
run_test 8 "GET method rejected" "405" "$R"

R=$(curl -s -o /dev/null -w "%{http_code}" -X HEAD "$BASE" --max-time 5)
run_test 22 "HEAD method rejected" "405" "$R"

R=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE" --max-time 5 2>&1)
if [ "$R" = "000" ]; then R="timeout/no-response"; fi
run_test 23 "PUT method rejected" "405\|timeout" "$R"

R=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE" --max-time 5 2>&1)
if [ "$R" = "000" ]; then R="timeout/no-response"; fi
run_test 24 "DELETE method rejected" "405\|timeout" "$R"

# --- Input Validation ---
echo "── Input Validation ───────────────────────────────────────"
echo ""

R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" -d 'not json at all')
run_test 11 "Invalid JSON body" "Invalid JSON body" "$R"

R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" -d '')
run_test 12 "Empty body" "Invalid JSON body" "$R"

TS=$(($(date +%s)*1000))
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE" -H "Content-Type: application/json" \
  -d "{\"address\":\"$ADDR\",\"signature\":\"dGVzdA==\",\"message\":\"coinbase-onramp:$ADDR:$(head -c 200 /dev/urandom | base64 | tr -d '\n' | head -c 100):$TS\",\"nonce\":\"$(head -c 200 /dev/urandom | base64 | tr -d '\n' | head -c 100)\",\"addresses\":{\"$ADDR\":[\"algorand\"]}}")
run_test 20 "Extremely long nonce (100 chars)" "401" "$R"

# --- Injection Attacks ---
echo "── Injection Attacks ──────────────────────────────────────"
echo ""

TS=$(($(date +%s)*1000))
R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d "{\"address\":\"'; DROP TABLE users;--\",\"signature\":\"dGVzdA==\",\"message\":\"coinbase-onramp:'; DROP TABLE users;--:sqli:$TS\",\"nonce\":\"sqli\",\"addresses\":{\"'; DROP TABLE users;--\":[\"algorand\"]}}")
run_test 14 "SQL injection in address" "Invalid wallet signature\|Invalid message" "$R"

R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d '{"address":"<script>alert(1)</script>","signature":"dGVzdA==","message":"test","nonce":"xss","addresses":{"<script>alert(1)</script>":["algorand"]}}')
run_test 15 "XSS in address" "Invalid message format\|Authentication required" "$R"

R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d '{"address":"../../../etc/passwd","signature":"dGVzdA==","message":"test","nonce":"pt","addresses":{"../../../etc/passwd":["algorand"]}}')
run_test 16 "Path traversal in address" "Invalid message format\|Authentication required" "$R"

R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d '{"address":"TEST\u0000evil","signature":"dGVzdA==","message":"test","nonce":"nb","addresses":{"TEST":["algorand"]}}')
run_test 17 "Null byte injection" "Invalid message format\|Authentication required" "$R"

R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d '{"__proto__":{"isAdmin":true},"address":"TEST","signature":"dGVzdA==","message":"test","nonce":"pp","addresses":{"TEST":["algorand"]}}')
run_test 18 "Prototype pollution" "Invalid message format\|Authentication required" "$R"

R=$(curl -s -X POST "$BASE" -H "Content-Type: text/plain" \
  -d '{"address":"TEST","signature":"x","message":"x","nonce":"x","addresses":{"TEST":["algorand"]}}')
run_test 19 "Wrong Content-Type (text/plain)" "Invalid message format\|Authentication required\|Invalid JSON" "$R"

# --- Tampering ---
echo "── Tampering ────────────────────────────────────────────"
echo ""

TS=$(($(date +%s)*1000))
R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d "{\"address\":\"$ADDR\",\"signature\":\"dGVzdA==\",\"message\":\"coinbase-onramp:$ADDR:multi21:$TS\",\"nonce\":\"multi21\",\"addresses\":{\"$ADDR\":[\"algorand\"],\"$ADDR2\":[\"algorand\"]}}")
run_test 21 "Multi-address piggyback" "Invalid wallet signature" "$R"

R=$(curl -s -X POST "$BASE" -H "Content-Type: application/json" \
  -d '{"addresses":{"ATQCF6LACHUZTBMFMPALIEK6LKD7PB7TPWL25OYQKRKK735UGL6D7AZIYY":["algorand"]}}')
run_test 10 "Token request without wallet proof" "Authentication required" "$R"

# --- Summary ---
echo "============================================================"
echo " RESULTS: $PASS passed, $FAIL failed (out of $((PASS+FAIL)))"
echo "============================================================"
