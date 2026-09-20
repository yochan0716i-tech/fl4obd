# FL4 OBD Analyzer v1

## Files
- analyze.html: capture-only UI (no charts).
- lib/analyzer-core.js: read-only command gate, ELM request/response state machine, payload reconstruction, scheduler selection, verified initialization order.
- lib/analyzer-app.js: Web Bluetooth, lifecycle/reconnect, DID editing, markers, IndexedDB journal, JSONL download.
- analysis_profile.json: byte-for-byte copy of codex/prompt/analysis_profile.json.
- tools/analyzer-test.mjs: Node tests; uses existing lib/did2920.js and testdata/dummy_drive.txt.
- docs/analyzer-v1.md: this document.

Existing index.html, viewer.html, telemetry.html and lib/did2920.js are not modified.

## Usage
Serve the repository over HTTPS or localhost. Open analyze.html in Android Chrome.
REC START may be pressed before CONNECT to include initialization within the session.
CONNECT alone records connection diagnostics but does not poll DIDs.
REC STOP waits for the current request/recovery to finish and writes session_end.
DISCONNECT stops the connection loop but does not end REC; reconnect manually to continue the same session.
Analysis JSONL exports the current REC session, or the most recently started REC session when idle/reloaded. Only rx_chunk events are excluded; rx raw/payload/decoded and all other event types belonging to that session are retained. No REC session means no analysis download.
Full JSONL exports the complete local journal, including previous sessions, diagnostics outside REC and rx_chunk.
Selection is snapshotted at click time; saving never clears or mutates the journal.
session_id distinguishes recordings. session_id:null denotes diagnostics outside REC.
Local timestamps use ISO 8601 UTC. The UI labels last-response time as UTC.

## Collection and safety
Initial DID periods: 2920=200 ms, 2902=1000 ms, 2922=1000 ms.
Periods are target intervals, not guaranteed rates; one request is active at a time.
At each scheduling step, the most overdue enabled DID is selected. No backlog burst is replayed.
Editable periods are limited to 100..3600000 ms.
User-entered DIDs are exactly four hex digits, forming 22xxxx.
The final send gate permits only 01xx, 22xxxx, and ATZ/ATE0/ATL0/ATS0/ATSP0/ATDPN.
2902 and 2922 remain unknown: no offset, scale, signedness, endian or unit assumptions.
Only 2920 gets auxiliary decoded fields using lib/did2920.js.

## Reuse from current index.html
- Full FFF0/E781 service UUIDs, characteristic property discovery and notify/write fallback.
- writeValue(TextEncoder(command + CR)).
- Prompt-delimited response processing, one outstanding request.
- Stop ATZ, prompt; reset ATZ, ELM327; ATE0/ATL0/ATS0/ATSP0 with 300/300/300/500 ms delays.
- Initial 011F waits up to 20 seconds per attempt (up to three completed failures, 1 second between them).
- ATDPN after successful 411F; no fixed protocol or header/flow-control override.
- Reconnect backoff 1/2/4/8 seconds and screen wake lock behavior.

The recorder intentionally does not copy the monitor's buffer discard on page visibility changes.

## Timeout recovery
DID requests wait 3 seconds. A timeout is logged with any partial raw text.
The expired request is quarantined; no new command is sent until its prompt arrives.
An additional 3-second drain window allows a late response to be logged with its ORIGINAL seq/cmd/did and late:true.
If the prompt does not arrive, close the BLE link, reconnect/reinitialize, and continue the recording.
NO DATA / STOPPED with a prompt completes the request and allows another DID to run.
A stalled initial 011F aborts that connection attempt rather than sending another command into SEARCHING.

## Log semantics
- tx/rx carry seq, cmd, did when applicable; raw is present on all rx events including failures.
- rx_chunk stores each received BLE text notification before parsing. This is forensic data, not an additional response to count.
- rx is the canonical prompt-terminated response. late:true responses do not change the timeout outcome/count.
- transport_closed stores unfinished raw data before any reset.
- payload is emitted only when reconstruction is structurally valid and matches the requested service/DID.
- session_start includes the full profile snapshot and active DID settings.
- config records edits, mark records markers, session_end records successes/errors including deleted DIDs.
- Events are kept in memory and asynchronously journaled to IndexedDB; journal failure is shown in the UI.
- Reload restores the journal. Saving does not erase it.
- Abrupt browser/OS termination can still lose events whose IndexedDB transaction has not completed.
- The recent-event UI is limited to 60 rows; the journal is not truncated.

## Validation
Run from repository root:
    node --test tools/analyzer-test.mjs tools/analyzer-export-test.mjs

11 tests pass: command restrictions, profile, 388 fixture frames in Veepeak/legacy formats,
unknown-DID treatment, overdue selection, fragmented raw, NO DATA continuation,
timeout quarantine/late attribution, disconnect partial retention, write failure, initialization order/timeout.

Browser test used a LOCAL SIMULATED BLE adapter (not a vehicle):
188 decoded 2920 responses, 40 NO DATA failures, 1 timeout and late response, 1 reconnect,
1 marker, 0 overlapping requests, 0 unsafe commands, no decoded fields on unknown DIDs.
DID add/disable/delete and period editing were exercised.
IndexedDB reload recovery and JSONL generation/JSON parsing were exercised (881 events, 286 rx with raw).
The in-app browser did not expose a download completion event; validate the Android download destination on the real device.

## Real-car checks still required
- Android Chrome permission/service discovery and actual ELM initialization/protocol.
- 2902/2922 response lengths and statuses, effective cadence and timeout thresholds.
- Reconnection, background/resume and wake lock on the user's device.
- Long recordings, IndexedDB storage headroom and Android JSONL file download.

Export-specific regression tests cover current/latest REC selection, rx_chunk removal only, full-history export, lossless JSONL fields, UI filenames, no-session guidance and STOP/START during save (9 tests).

## v1.1: one-tap markers and SOC
BRAKE / ACCEL / BRAKE+ACCEL / LIGHT / HIGH_BEAM / A/C / CUSTOM are direct buttons enabled only during REC. Each click emits the existing mark event immediately; only CUSTOM uses the note field.
The profile adds PID 5B (015B), enabled at 1000 ms. SOC shares the same one-request-at-a-time overdue scheduler with existing DIDs; enable, period and counters are shown in the table. Reload restores profile defaults.
SOC rx records retain raw/payload and add pid:"5B", decoded:{soc:A*100/255}. Padding is ignored. Missing SOC bytes are failures. NO DATA and timeouts use the existing recovery path. Session-end counts use key "015B", retaining the previous DID keys.
Additional tests: node --test tools/analyzer-soc-marker-test.mjs
