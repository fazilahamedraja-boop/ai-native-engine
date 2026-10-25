# Pre-flight failure (runner bug, no defect applied)

The runner refused to inject the controlled defect because its exact-string
match assumed LF line endings while this checkout uses CRLF:

```text
Error: healthy terrain function did not match the expected source; refusing to inject
```

No defect was applied and no agent ran. The guard behaved correctly: it stopped
before writing a misleading experiment. The match was changed to a
line-ending-tolerant function pattern and the experiment was re-run in a new
timestamped directory.
