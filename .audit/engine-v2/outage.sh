#!/bin/bash
# outage.sh <writerUdid> <readerUdid> <writerWrapper> <optionRef> <offlineSeconds> <logName>
# Cuts the Mac's Wi-Fi (both simulators share it), taps the picker option on the writer, waits, restores Wi-Fi,
# and leaves the timing to measure.ts outage. Wi-Fi is restored on every exit path.
set -u
cd /Users/stefan/code/sync-engine/.audit/engine-v2 || exit 1
W=$1; R=$2; WRAP=$3; REF=$4; OFFLINE=$5; LOG=$6
stamp() { date -u +%FT%T.%3NZ; }
restore() { networksetup -setairportpower en0 on; echo "$(stamp) wifi on"; }
trap restore EXIT
networksetup -setairportpower en0 off || { echo "could not turn wifi off"; exit 1; }
echo "$(stamp) wifi off"
sleep 4
if curl -s -m 3 https://a-better-me.stf.lol/status; then echo "production still reachable, aborting"; exit 1; fi
SERVER_URL=https://a-better-me.stf.lol bun measure.ts outage "$W" "$R" settings > "$LOG" 2>&1 &
MP=$!
sleep 2
echo "$(stamp) tapping $REF on the writer"; ./"$WRAP" click "$REF" 2>&1 | tail -1
for i in $(seq 1 200); do grep -q "queued offline" "$LOG" && break; sleep 0.1; done
grep -q "queued offline" "$LOG" || { echo "write never queued"; kill $MP; exit 1; }
echo "$(stamp) queued; staying offline ${OFFLINE}s"
sleep "$OFFLINE"
trap - EXIT
restore
wait $MP
echo "$(stamp) measure exited $?"
