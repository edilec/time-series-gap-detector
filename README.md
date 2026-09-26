# Time Series Gap Detector

Offline, read-only analysis of timestamped telemetry exports. It detects missing, duplicate, late, and out-of-order intervals per configured device; it does not contact devices or a time-series database. Node.js 22+, zero dependencies. `src/index.mjs` exports `detectGaps(recordsDoc, policy, {now, deadline})` and `TOOL_ID`.

```sh
node bin/time-series-gap-detector.mjs --root examples --policy policy.json --records passing-records.json
node bin/time-series-gap-detector.mjs --root examples --policy policy.json --records failing-records.json
```

The synthetic examples exit 0 and 1. `--help` prints usage to stderr; normal runs print a bounded human summary to stderr. Stdout contains only the v1 JSON report.

Policy is `{"schemaVersion":"1","asOf":"2026-03-08T10:00:00Z","devices":[{"id":"synthetic-device","timeZone":"America/New_York","cadenceMinutes":60,"lateGraceMinutes":30,"windowStart":"2026-03-08T06:00:00Z","windowEnd":"2026-03-08T08:00:00Z"}]}`. Record export is `{"schemaVersion":"1","complete":true,"records":[{"deviceId":"synthetic-device","observedAt":"2026-03-08T06:00:00Z","receivedAt":"2026-03-08T06:00:00Z"}]}`. All instants are strict UTC timestamps; every policy device has an explicit valid IANA timezone. Cadence means **elapsed UTC minutes** between expected instants, not local wall-clock labels. The timezone is validated as device context but is not used to add wall-clock hours, so a spring-forward/fall-back DST transition creates no phantom gap. Window endpoints are inclusive and must align to cadence.

A record at an expected instant covers its slot even if it arrives late. `receivedAt > observedAt + lateGraceMinutes` is a late-record failure, distinct from a missing slot. An absent slot is `pending-gap` (incomplete) before grace ends, `permanent-gap` (failure) at or after grace ends when the export asserts complete coverage. Partial exports do not assert permanent gaps. Duplicate/out-of-order checks use each device's exported record order, and off-cadence observations fail separately. `asOf` is supplied in the policy, not read from the system clock.

| Rule ID | Severity | Meaning |
| --- | --- | --- |
| policy-invalid | warning | invalid cadence/timezone policy (CLI rejects configuration) |
| records-invalid | warning | malformed/out-of-window/inconsistent record or export |
| records-incomplete | warning | export declares partial coverage |
| device-unknown | warning | telemetry device absent from cadence policy |
| pending-gap | warning | expected interval still within arrival grace |
| limit-exceeded | warning | byte, count, depth, slot, or time bound exceeded |
| input-unreadable | warning | records unreadable, undecodable, or unparseable |
| permanent-gap | error | complete export lacks slot after grace |
| duplicate-record | error | same device/instant repeats |
| out-of-order | error | device observations regress in source order |
| off-cadence | error | observation does not align to elapsed cadence |
| late-record | error | receipt after allowed grace |

Findings sort by code unit `(location.file, location.pointer, ruleId)`. `@policy` and `@records` are fixed logical source roles, not host paths; record findings point to zero-based source ordinals. Gap findings point to the actual policy device record and name only a derived, bounded slot ordinal—never an invented source path or private device ID. Exit 0 pass, 1 completed failure, 2 incomplete evidence/configuration. Invalid usage, root, path, or policy leaves stdout empty; unreadable or ambiguous record input emits an incomplete JSON report. Input paths are relative and realpath-confined beneath the declared root.

Limits: policy ≤64 KiB, record export ≤1 MiB, ≤100 devices, ≤10000 records, ≤10000 expected slots, JSON depth ≤16, injected evaluation deadline 5 seconds. Strict UTF-8 and duplicate JSON key checks include escaped aliases. Bound breaches are incomplete, never truncated. The checker trusts the export's completeness assertion and does not infer local-wall-clock sampling intent or device clock calibration. Run `npm run check` for syntax and tests.

Device IDs are opaque, case-sensitive keys of 1–256 characters. Uppercase letters and punctuation are allowed; blank, control, line-separator, and Unicode format characters are rejected. IDs are never rendered in reports.
