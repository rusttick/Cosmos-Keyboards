# Keypress vectors: problem framing, not yet a plan

> **Status:** Problem framing, no experiments proposed yet · Depends on: `key-point-selection.md`,
> `scan3-architecture.md`, `representing-keyboard-build-inputs.md` · Related: `goals.md`,
> `scan-utility-evaluation.md`, `archive/problems.md`

`representing-keyboard-build-inputs.md`'s capability-field viewer currently renders a point per
sampled joint-angle configuration — a position, nothing about how a key could actually be pressed
there. The next visible step (replacing those points with vectors) turns out to require answering
several real, currently-unresolved modeling questions first, not just adding an arrow to an existing
dot. This doc exists to **name and organize those questions** before any of them get answered or any
experiment gets designed — per the project's own recurring lesson (`test-results.md`'s repeated
"live-verify, don't guess" pattern, and `key-point-selection.md`'s own discipline about not smuggling
assumptions into a supposedly assumption-free algorithm), picking an answer under time pressure here
would silently constrain the whole keyboard-design space this project exists to leave open
(`goals.md`'s stated goal: replace "a small set of hand-shape parameters" with something that "places
keys directly against the wearer's actual measured hand geometry," not a new set of hidden shape
assumptions one level down).

No conclusions or recommendations below. This is a map of what's unresolved, and why it's genuinely
unresolved rather than merely undecided.

## The question that started this

Given a point already known to be reachable (a sample in the capability field), in which direction (or
directions) does a keypress actually happen there? `key-point-selection.md`'s own text answers this in
one paragraph ("Orientation from the local Jacobian" — the SVD of the local Jacobian gives a press axis
and two in-plane axes, unchanged from an earlier draft of the algorithm) — but pulling on that thread
surfaced a second, independently-designed answer to a closely related question already sitting in
`scan3-architecture.md`, and the two don't obviously agree. That disagreement, not a shortage of ideas,
is the actual problem.

## What the project's own docs already propose, and where they come from

**The kinematic model — `key-point-selection.md`, "Orientation from the local Jacobian."** The SVD of
the local Jacobian (already computed for Stage 8's manipulability scalar, `manipulability.ts`) at a
sampled joint-angle configuration gives an orthonormal frame: the largest-singular-value left singular
vector is the "principal direction of local motion" (proposed as the press axis), the other two complete
a keycap orientation frame. This is a standard robotics/biomechanics construction — velocity/force
manipulability ellipsoids are a well-established way to express "the preferred direction in which
velocity or force control commands may be performed at a given joint configuration," confirmed against
external sources, not just this project's own citation
([Manipulability ellipsoid — Wikipedia](https://en.wikipedia.org/wiki/Manipulability_ellipsoid)). It is
a purely kinematic quantity: a function of joint angles and bone lengths, with **no reference to the
finger's physical surface at all** — it would produce the same answer whether the fingertip were a
point, a pad, or a fingernail.

**The geometric model — `scan3-architecture.md`, "Contact spheres: the fingertip is not a point."**
Written to solve a different-sounding but related problem: `SolvedHand.worldPositions(finger)[4]` is a
zero-radius skeletal point, but "a real key press happens somewhere on the volume of the fingertip, not
at that exact point, and not always with the same part of the finger — the pad, the underside of the
nail, the side of the finger, and (for the thumb especially) the area nearer the IP joint are all real,
distinct ways a key gets pressed." Its answer: model each pressable landmark as a sphere
(`{ landmark, offset, radius }`); a press can land anywhere on that sphere's surface, "approaching along
that point's local normal." This is a purely geometric quantity: a function of _where on the finger's
surface_ contact happens, with **no reference to joint kinematics at all** — the direction it produces
depends on which point you pick on the sphere, not on how easily the finger can move there.

**Neither model has been implemented.** Confirmed directly: `ContactSphere`/`ContactSpheres` exists only
in `scan3-architecture.md`'s text — no type, no code, anywhere in `src/`. The live `/beta` app still uses
`HAND_RADIUS = 2` (`viewer3dHelpers.ts`), a single hardcoded global offset with no per-landmark, per-style
variation at all — precisely the thing the contact-sphere design was written to replace. The
capability-field viewer (`representing-keyboard-build-inputs.md`) inherits the same simplification: every
sample is the raw skeletal landmark, offset zero, no notion of surface or approach direction.

**Corroborating context, not a third model.** `scan-utility-evaluation.md`'s Category 2 machinery (the
Jacobian/manipulability construction Stage 8 reused) and the cited descriptive literature
([Kinematics of the fingers and hands during computer keyboard use — PubMed](https://pubmed.ncbi.nlm.nih.gov/17052825/))
both support the kinematic model's plausibility (real typists' MCP/PIP joint angles and velocities during
typing were measured normatively) but don't themselves specify a fingertip-surface contact point, and
reviewing that paper in enough depth to know whether it reports anything about the actual 3D direction of
fingertip travel during a keystroke (as opposed to joint-angle time series) has not been done — an
open literature-review gap, not a settled "no."

**External confirmation that the contact-point question is real, not hypothetical.** Patent search
turned up ergonomic keyboard designs using nail-side actuation at full finger extension and
lateral/underside finger actuation, not just pad-center presses
([Ergonomic keyboard input device](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/5178477),
[Finger operated switching apparatus](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/4761522)).
The design space `scan3-architecture.md` anticipated is one real keyboards actually occupy, which raises
the stakes on getting this right rather than defaulting to pad-center by omission.

## Open problem threads

Each of these is currently unresolved for a reason described alongside it, not just unstarted.

### 1. Two models answer different questions and may disagree

The kinematic (Jacobian) and geometric (contact-sphere) models were each written to solve a real
problem, correctly, on their own terms — but nothing in either doc establishes how they relate. A
geometrically natural nail-top contact point has no guaranteed relationship to the direction the finger
can most easily move in at that joint configuration; they could point the same way, or not, for any
given sample. Treating one as "the" answer would silently discard whichever real design consideration
the other one captures.

### 2. Contact-point geometry has no source of ground truth

`scan3-architecture.md`'s own text is explicit that this is unsolved, not merely unstarted: "Getting the
offset right — where the sphere center actually sits relative to the tracked landmark, and what its true
radius is — is deliberately left unsolved here. MediaPipe's landmarks... are all produced the same way —
visually annotated skin-surface points, not skeletal measurements — so no landmark can be used as a
trusted reference to calibrate another." This project's whole measurement pipeline (`goals.md`,
`capture-protocol.md`) is built around MediaPipe-plus-caliper observations; a finger's actual
cross-sectional geometry (pad protrusion, nail position, lateral width) sits outside anything either
channel currently measures.

### 3. Continuous surface vs. discrete named styles

`scan3-architecture.md`'s sphere model is deliberately continuous — explicitly "rather than picking one
fixed offset or a small set of named contact 'modes' (which would quantize what's actually a continuous
choice of approach direction)." But the patent evidence above, and the way people actually describe
alternate keyboard designs (pad, nail-top, side, underside-near-nail, thumb-near-IP-joint), suggests a
handful of real, nameable styles rather than an unstructured continuum. Whether to model this as a
continuous surface parameter (general, but harder to reason about, calibrate, or expose to a person
choosing a design) or a discrete enumerable set (tractable, but risks re-introducing the exact
quantization the sphere design was written to avoid) is unresolved, and the two docs currently
implicitly disagree about which framing is right.

### 4. Whether "one vector per sample" is even the right output shape

If contact style is a real free dimension, a single capability sample might correspond to several
genuinely different, simultaneously valid presses (different contact point, different direction, at the
same joint configuration) rather than one canonical vector. Whether the eventual representation — in the
capability-field viewer, and later in `key-point-selection.md`'s own per-key orientation output — should
be one vector per sample, a small bundle per sample, or something else, is downstream of resolving (1)
and (3), not answerable on its own.

### 5. Degenerate (rank-deficient) kinematic configurations

Some capability samples come from genuinely 2-DOF sweeps (the thumb CMC-only slice, and any legacy
MCP-only sampler) whose local Jacobian is rank-deficient by construction — confirmed and unit-tested in
`manipulability.ts`. The SVD still exists mathematically, but the "dominant direction" and especially
the third/in-plane axis lose their ordinary physical meaning (the mechanism cannot move in some
direction at all, at that sample). It isn't established whether the geometric (sphere-normal) model has
an analogous degenerate case — plausibly not, since it doesn't depend on kinematic rank at all — which
would make the two models fail in different circumstances, not just disagree in ordinary ones.

### 6. Sign ambiguity in the kinematic model

An SVD determines its dominant axis only up to sign; nothing in `key-point-selection.md` specifies which
of the two directions is "the" press direction (into a keyboard, not away from one). This project has
repeatedly needed to resolve exactly this kind of ambiguity by live observation rather than derivation
(`thumbDepthSign`, `signedJointAngle`, and this session's own landmark-0 placeholder rotation, all in
`test-results.md`) — noted here as a likely-recurring pattern, not yet applied to this specific case.

### 7. Whether kinematic "ease of motion" is the right proxy for "how a press actually happens" at all

Manipulability ellipsoids describe kinematic capability, a real and standard quantity — but it's not
established that "the direction the finger can most easily move" is the same thing as "the direction a
person actually presses a key with that finger." `archive/problems.md` already imports separate motor-
control literature (Flash & Hogan's minimum-jerk model) for a related but distinct purpose — scoring
path cost from a rest posture to a target, not instantaneous press direction at an already-reached point.
Whether that literature (or something else) has anything to say about real keystroke direction
specifically, versus this project extending a robotics convenience metric into a claim about human
motor behavior it was never designed to describe, is unreviewed.

### 8. Is finger-contact geometry a hand-model parameter or a keyboard-design choice?

`goals.md` frames this project as producing two independent artifacts: a personalized hand model, and a
keyboard geometry generator that consumes it. Bone lengths and joint ROM clearly belong to the first.
Contact-point style (pressing with a pad vs. a nail vs. a side) is arguably neither purely anatomical
(it doesn't vary by measuring the hand more precisely) nor purely a generator-side free variable (it's
constrained by real finger geometry, which does vary by person) — it sits across the split `goals.md`
draws, and nothing in either doc currently says which side of that split it belongs on, or whether it
needs a third category.

### 9. Where this plugs into `key-point-selection.md`'s existing algorithm

If contact style becomes a real modeled dimension, it's not established whether it should be: another
free dimension sampled alongside joint angles in Step 1's candidate space; a choice applied only after
Step 3's packing has already selected a position; or something that changes which _positions_ are even
reachable in the first place, since different points on the same landmark's contact sphere are at
different physical locations, not just different orientations at one shared location. Each placement in
the pipeline has different consequences for what Step 3's packing and Step 5's cross-finger checks would
need to know about, and none of the existing docs commit to one.

## What this doc deliberately does not do

No recommendation is made among continuous-vs-discrete, kinematic-vs-geometric, or where in the pipeline
this belongs. No experiment is proposed to resolve any of the above. The point of writing this now,
separately from a plan, is so that whatever research or experimentation comes next can address one of
these threads deliberately, with the others named and visible, rather than discovering mid-implementation
that an unstated choice among them had already been made.
