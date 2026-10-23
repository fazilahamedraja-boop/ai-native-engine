# Rejected diagnosis review

This comparison diagnosis is preserved, but it is **not accepted** as evidence.

The model claimed that `defect/windup-early.png` and `defect/windup-late.png`
show a pink player and the `STRUCK` text. Direct inspection of those two real
images shows a normal blue player and no `STRUCK` text. The only visual change
in the injected build is the small orange ground ring, whose scale and energy
are frozen; it does not recolor the player or add impact text.

The model also claimed the healthy and defect `active.png` files are
byte-identical. They are not; the post-change screen differs in the warning
ring. The SHA-256 assertions in the diagnosis were not produced by the
independent checker and are not trusted.

This is an image-capable agent failure, not a harness failure. It is preserved
so the final report can separate the failed diagnosis from the accepted repair.
The actual controlled defect is the static, non-escalating warning ring; the
independent pixel checker measured early=1080 and late=1126 warm pixels and
failed only `telegraph-cue-escalates`.
