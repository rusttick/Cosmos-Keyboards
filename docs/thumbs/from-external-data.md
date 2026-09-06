# Using external hand-pose datasets

> **Status:** Research notes, not yet implemented · Depends on: `handModel.ts`, `handModelData.ts`,
> `ikSolve.ts` · Related: `average-hand.md`, `goals.md`

Three published hand-pose research datasets — FreiHAND, InterHand2.6M, and DexYCB/HO-3D — turned up
while researching how to test `handModelData.ts`'s priors against something other than themselves.
This doc covers two different uses for them, since the answer turned out to differ by field:

1. **Filling gaps in `HandPriorState`.** Several fields in `handModelData.ts` are explicitly marked
   as unsourced placeholders (`dipPipCoupling`, `enslaving.coefficients`, `mcpAxes.*.abAdChokeCoeff`,
   `mcpAxes.*.axialRotationWeight`, the thumb's `wristToCmc` bone segment, and several
   `wristForearm` coupling terms) or as "rough working figures, not checked against a specific named
   paper" (most `BetaRom` mean/SD values). Some of these gaps turn out to be fillable from real
   captured hand data — not by training anything, but by directly computing means, covariances, and
   regression coefficients from real 3D points, which is exactly the statistical operation
   `handModelData.ts` already performs on Buryanov & Kotiuk's published table today, just against a
   different (and in places much larger) source of raw numbers. Other gaps turn out **not** to be
   fillable this way at all — see "What these sources cannot fill" below, added because the first pass
   at this document assumed too readily that more landmark data solves every gap.
2. **Testing the model**, the original goal of this research. Once a data source has been used to fit
   part of `HandPriorState`, it can no longer also test that same part without reintroducing the exact
   circularity problem this whole investigation started from — just moved one level up, from "the test
   reads the same coefficient the code does" to "the test was fit from the same frames the code was
   fit from." The fix is ordinary train/test hygiene (a held-out subject split), not a new idea — see
   the last section.

Nothing here proposes training a neural network or any other black-box model. Every use below is a
closed-form statistical computation — sample mean, sample covariance, linear regression — over real
3D points, producing exactly the `ScalarPrior`/`VectorPrior`/`BetaRom` shapes `handModel.ts` already
defines. The "model" stays a set of named, inspectable mechanical relationships between landmarks;
these datasets are just a bigger, more diverse source of numbers to compute those relationships from
than the single 66-hand X-ray study `handModelData.ts` currently leans on for bone lengths, or the
"no usable measurement found" placeholders it currently carries for several couplings.

**A caveat that applies to everything below:** all three datasets are described in their papers as
using a 21-point-per-hand skeleton (wrist + 4 landmarks per finger), the same general convention
MediaPipe Hands uses and this project's `$lib/hand.ts` already consumes. That match is structural, not
an identical index order — see "InterHand2.6M's actual index order" below, confirmed directly against
a downloaded copy of the annotations rather than assumed from the paper. Before computing anything from
any of these datasets, build an explicit remapping table against `CONNECTIONS`/`LIMBS` and confirm it
by hand for at least one sample — a silent index or per-finger-direction mismatch would poison every
downstream number without ever throwing an error.

**A local copy of InterHand2.6M's annotations (not images) lives in `external-data/interhand26m/`** —
gitignored, not committed, since it's a ~63MB third-party research download, not project source. It
holds, per split (`train`/`val`/`test`): `InterHand2.6M_{split}_joint_3d.json` (the 3D joint
coordinates), `InterHand2.6M_{split}_camera.json` (per-capture calibration), plus top-level
`skeleton.txt` (joint index/hierarchy) and `subject.txt` (27 subject IDs, each mapped to which
train/val/test capture directories belong to that person — exactly what a subject-level held-out split,
described below, needs). Deliberately left out: `InterHand2.6M_{split}_data.json` (a COCO-style index
of the _image_ files, irrelevant without the images) and `InterHand2.6M_{split}_MANO_NeuralAnnot.json`
(a neural-net-fitted MANO overlay — skipped both because it isn't needed for the closed-form approach
below and because it's the output of a trained model, which is exactly the kind of dependency this
project is trying to avoid taking on itself). Re-fetch instructions: the official homepage
(https://mks0601.github.io/InterHand2.6M/) links a Google Drive folder for the "5 fps (H+M)"
annotation-only release; the four file types above are the only ones this project pulls from it.

## The three sources

### FreiHAND

A dataset of real human right hands built from a **calibrated multi-camera rig**: multiple synchronized
RGB cameras around the subject, a 2D keypoint detector run independently per view, those 2D detections
**triangulated** across views into 3D point hypotheses (plain multi-view geometry, not a learned 3D
model), and a MANO mesh fit to that point cloud for a full shape+pose estimate. Human annotators then
reviewed every fit against a 3-criterion quality heuristic and rejected or corrected bad ones, over
four full passes of the dataset.

Numerically: `xyz.json` gives 21 3D keypoints per sample, in **meters**, camera-space. `K.json` gives
camera intrinsics (not needed if only the metric 3D points are wanted). `mano.json` gives the same pose
as 61-dim MANO parameters (10 shape, 45 pose as 15 joints' axis-angle, 6 global rotation+translation) —
an alternate representation, not needed if working from `xyz.json` directly. 130,240 training samples
plus ~3,960 evaluation samples, each an **independent still capture** of a different pose — no time
axis, so nothing here says how one frame's pose relates to the next.

### InterHand2.6M

Captured in a synchronized studio dome (34 color + 46 monochrome cameras) across 23 subjects performing
one- and two-handed poses. Ground truth is close to as model-free as this kind of data gets: a **human
annotator clicked** each of the 21 joint positions directly in the easiest camera view, clicked the
same joints again in a second view, and the tool **triangulated** those two clicks into 3D and
reprojected into every other camera to check consistency — no MANO fit, no learned 3D estimator,
involved in generating the base annotation at all.

Numerically: `joint_3d.json` gives 21 joints per hand (42 for two-hand frames, root index 20/41) in
**millimeters**, indexed by frame within real captured sequences, plus `joint_valid` occlusion flags.

**InterHand2.6M's actual index order** (confirmed directly from the downloaded `skeleton.txt`, not
assumed from the paper): each finger's 4 joints are numbered **tip-to-base** — e.g. index 0–3 are
`thumb4, thumb3, thumb2, thumb1` (tip first, base last) — in finger order thumb, index, middle, ring,
pinky, with the wrist last at index 20 (right hand) / 41 (left hand, offset +21). That's the opposite
direction from `$lib/hand.ts`'s convention, which numbers wrist-first and each finger base-to-tip. The
underlying anatomical layout still matches (wrist + exactly 4 joints per finger, thumb included at 4
like every other finger — so the same "no real CMC landmark, thumb's first joint is really its
MCP-equivalent" ambiguity `handModelData.ts`'s `wristToCmc` comment already describes for MediaPipe
applies here too), so a per-finger reversal plus an index-order remap is enough to align the two — not
a resegmentation, but not a direct pass-through either. Any code reading `joint_3d.json` needs that
remap applied explicitly and checked against a known pose before trusting a single downstream number.

The real coverage is smaller than the "2.6M" name suggests: only ~7,600 timestamps were directly
hand-clicked this way (expanding to 257K 2D observations once projected across all camera views); the
released frame count comes from propagating/interpolating between those annotated keyframes with
additional automated fitting. Worth knowing before assuming every one of the 2.6M frames carries the
same annotation rigor as the ~7,600 keyframes did. This is the only one of the three with **real
temporal continuity** — an actual hand moving through a sequence, not independent stills.

### DexYCB / HO-3D

Real people grasping physical YCB household objects, captured from fewer views than InterHand2.6M's
dome (DexYCB: 8 RGB-D views, 10 subjects, 582K frames; HO-3D: 1–5 views, ~78K frames, and per its own
writeup at least partly relies on physical motion-capture markers rather than vision alone). Ground
truth comes from **optimization**, not triangulation: human-labeled 2D keypoints per view feed a
differentiable-MANO fitting procedure that jointly optimizes the hand mesh and the (known-geometry)
object's 6D pose against the 2D/depth observations.

Numerically, this is the one real format mismatch: DexYCB's `pose_m.npy` stores **48 PCA-reduced MANO
pose coefficients + 3 translation values per frame**, not raw joint positions. Getting the 21×3 joint
positions out requires running those through MANO's forward-kinematics decoder first — a Python/
PyTorch dependency the other two sources don't need. The motion itself is also narrower: task-directed
grasping of specific objects, not free range-of-motion exploration — a worse match for this project's
"how does an open hand move" questions than FreiHAND or InterHand2.6M, for the added cost of a MANO
decode step.

## Filling `HandPriorState` from these sources

Going field by field through `handModel.ts`'s groups. "Recoverable" means: computable as a mean/
covariance/regression directly from the dataset's raw 3D points, no model training involved.

**`boneLengths` (Group A).** Directly recoverable, and possibly the single best use of these sources.
Every sample in FreiHAND and every annotated frame in InterHand2.6M gives real metric-scale 3D joint
positions for a real person's hand — the segment-length ratios `vectorPriorFromRatios` computes from
Buryanov & Kotiuk's 66-hand table can be computed the same way from these, at a scale of thousands of
distinct subjects rather than 66, and computed directly from raw points rather than trusting a
published summary table's mean/SD. Concretely: this is the direct fix for the one placeholder
`handModelData.ts` flags most explicitly — the thumb's `wristToCmc` segment, currently a "re-eyeballed
against a reference diagram" guess with no source at all, because Buryanov & Kotiuk's X-ray table
doesn't cover it. If a dataset's 21-point convention really does include that same extra
wrist-to-thumb-base landmark (see the caveat above — confirm this first), its length is measurable
directly from real hands the same way every other segment already is, replacing a guess with actual
data. The existing `RawSegmentMM { mean, sd }` shape and `vectorPriorFromRatios` machinery need no
changes — only the input numbers change.

**`pipDipRom` / `mcpAxes.{flexExtRom,abAdRom}` / `cmcMobility.*.{flexExtRom,abAdRom,flexionRom}`
(Groups B–D's `BetaRom` fields).** Partially recoverable, with an important reframe. `BetaRom` stores
two different kinds of number: `minDeg`/`maxDeg` (a hard anatomical stop) and `meanDeg`/`sdDeg` (a
typical value and how much it varies). These three passive-capture datasets are poor sources for the
first kind — people photographed or filmed going about natural poses or object grasps don't hyperflex
or hyperextend their joints to the anatomical limit, so the true clinical minDeg/maxDeg won't show up
in the data (DexYCB's grasp poses may approach full flexion for some joints, which is the one partial
exception). But they're a **good, arguably better** source for the second kind: computing the sample
mean and SD of each joint's flexion/ab-ad angle across thousands of real, naturally-occurring poses
gives a real "how do people actually hold their hand" distribution — which for this project's actual
application (typing posture, not clinical range testing) may be a more useful number than a clinically
correct but rarely-approached maximum. Recipe: recover each joint's angle from a dataset frame's raw
landmark chain the same way `ikSolve.ts`'s own `trackedPose` already does for a live tracking frame
(there's no new math here — it's the identical per-joint direction-recovery this project already has),
then take the sample mean/SD across many frames and subjects as the new `meanDeg`/`sdDeg`, leaving
`minDeg`/`maxDeg` to whatever clinical literature source is already seeding them (or a second, more
targeted goniometry paper, if one is found — a separate task from this one).

**`dipPipCoupling` (Group E).** Directly recoverable, and one of the strongest matches, particularly
from InterHand2.6M's continuous sequences. The relationship stored (`dip ≈ slope·pip + intercept`) is
a two-parameter linear regression — needs nothing more than DIP angle and PIP angle recovered from the
same frame, across enough frames to fit a line with a meaningful residual/covariance. Unlike enslaving
below, this doesn't need any instructed-motion protocol or intent labeling: DIP and PIP move together
constantly during any natural hand use, so ordinary passive-capture frames are exactly the right data,
and having real continuous motion (InterHand2.6M) rather than independent stills (FreiHAND) matters
here specifically, since a coupling claim is fundamentally about how two things move together, which a
single still can't show as directly as a sequence can (though a large enough set of independent stills
still gives a valid cross-sectional regression).

**`enslaving.coefficients` (Group F).** Recoverable, but only as a different, honestly-relabeled
quantity — not a real fix for the gap as currently defined. `handModelData.ts`'s own comment is explicit
that true enslaving is a specific experimental finding: instruct someone to move _only_ finger `i`, and
measure how much finger `j` moves involuntarily anyway. None of these three datasets used that
protocol — they capture natural poses or object-grasping tasks, where multiple fingers moving together
reflects ordinary voluntary co-contraction as much as (or more than) true involuntary enslaving; the
two are conflated in any passive-observation dataset, not separable after the fact. What **is**
computable is a different, useful thing: the observed correlation in how much each finger's joints
flex together during real natural motion (a regression of finger `i`'s total flexion against finger
`j`'s, the same shape `handModelData.ts`'s matrix already expects). That's worth having — arguably more
relevant to typing than a force-study-defined enslaving coefficient would be — but it should go into
`HandPriorState` labeled for what it actually is ("observed co-flexion correlation during natural
motion, conflating enslaving and voluntary co-contraction"), not silently presented as if it satisfies
the original enslaving definition the field's own doc comment describes.

**`mcpAxes.*.abAdChokeCoeff`.** Recoverable the same way as `dipPipCoupling`: regress each MCP's
observed ab/ad half-range (or ab/ad angle variance within a flexion bucket) against that same frame's
flexion angle, across enough frames spanning a range of flexion values, to fit "how much side-to-side
range shrinks per degree of flexion." Needs a dataset with real variety in MCP flexion — InterHand2.6M
or DexYCB's grasp sequences (which pass through a wide flexion range) are better suited than FreiHAND's
independent stills, which may cluster around comfortable rest poses.

## What these sources cannot fill

Two categories of gap survive no matter how much of this data gets used, and they're worth stating
plainly rather than discovering after the fact:

**`mcpAxes.*.axialRotationWeight` and the axial-roll half of any `degree: 3` joint's twist, in the
general case.** A bone spinning about its own long axis produces little to no visible displacement of
the sparse landmarks at its two ends — a phalanx can roll freely without moving the joint point at
either tip. What actually lets this project's own `thumbCmc.ts`-style fitting recover a twist
coefficient at all is that the twist changes how the _downstream_ chain's local frame is carried
forward, which shows up as a small, indirect deflection in the distal landmarks' positions relative to
what a no-twist model predicts — but reading that signal out correctly depends on already having each
joint's own calibrated local axis convention (`V`/`Vinv`), which `ikSolve.ts`'s own doc comments are
explicit is "a real per-user calibration fact this project only ever gets from fitting actual captured
motion," not something derivable from raw landmark positions alone, and not something any of these
three datasets provides (none of them carry CT-level bone-axis imaging). Fitting an axial-twist
coefficient from external landmark data without an independently known axis convention risks fitting
an artifact of whatever convention gets assumed rather than a real anatomical quantity. This gap stays
exactly what `handModelData.ts` already says it is: needs either a specific 4D-CT literature source, or
this project's own calibrated capture pipeline — not these datasets.

**All of `wristForearm` (Group G).** All three datasets capture the hand only — no forearm, no elbow,
no upper arm ever appears in frame. Nothing here helps `wristFlexExtRom`, `elbowFlexionRom`,
`tenodesisCoupling`, `forearmLengthStatureCoupling`, `swivelWristForearmCoupling`, or any other Group G
field at all.

## Testing, revisited

The original goal here was independent test data, before the discussion above showed some of this data
is better spent filling `HandPriorState`'s gaps than checking them. Both goals can still coexist, but
only with one discipline enforced: **whatever subset of a dataset gets used to fit a coefficient can
never also be used to test that same coefficient.** That's not a new problem to solve — it's the
ordinary train/test split any statistical fit needs, applied at the _subject_ level, not the frame
level (frames from the same person are correlated with each other, so splitting frames within one
subject between "fit" and "test" would leak information across the split). Concretely: pick a subset of
InterHand2.6M's 23 subjects (or FreiHAND's captured individuals) up front, fit every `HandPriorState`
field sourced from this data using only the remaining subjects, and reserve the held-out subjects
exclusively for checking the result — never touched during fitting. This is still not model training in
the sense you want to avoid; it's the same discipline any honest regression needs so the "test" isn't
just reading back a number the "fit" already guaranteed would match.

With that split enforced, the tests from the earlier research pass are still exactly the right shape,
and some get sharper now that there's a concrete source of held-out real poses to run them against:

- **ROM/coupling-violation checks against held-out subjects.** For each held-out subject's frames,
  recover joint angles the `trackedPose` way and check they fall within the _fitted_ `BetaRom`/coupling
  bounds. A held-out real hand landing outside the fitted range is a real finding about the fit, not a
  circular restatement of it, because that subject's data never touched the fit.
- **Self-collision / interpenetration checks remain independent regardless of the split**, since they
  never reference any `HandPriorState` field at all — a fist pose from a held-out _or_ a fitting-set
  subject either does or doesn't have two finger capsules intersecting, a pure-geometry fact.
- **Metamorphic checks** (mirror symmetry, monotonicity, fixed-point stability on `solvePose`, described
  in the earlier research pass) stay valid unconditionally — they check relationships internal to the
  solver's own math, not agreement with any dataset, fitted or not.
- **InterHand2.6M is the strongest single source for both roles at once**: 23 subjects is enough to hold
  out several entirely for testing while fitting on the rest, and its real continuous sequences are the
  only one of the three that can test a coupling claim (DIP tracking PIP, ab/ad choking with flexion)
  the way the claim is actually stated — as a relationship over a sequence of motion, not a single
  cross-sectional snapshot.

## Recommended path

Prioritize InterHand2.6M: verify its landmark ordering against `CONNECTIONS` first, then use a
subject-level held-out split to both (a) fit bone-length ratios, DIP/PIP coupling, and the MCP choke
coefficient, and (b) test the result against the reserved subjects plus the collision/metamorphic checks.
Use FreiHAND as a secondary source to widen the bone-length sample further (its independent-stills
format doesn't help the coupling fits, which need real motion). Treat DexYCB/HO-3D as low priority —
the MANO-decode dependency and narrower grasp-only motion make them costly for what they'd add over
InterHand2.6M. Don't attempt to source `axialRotationWeight` or any `wristForearm` field from any of
the three; those stay literature-or-own-capture problems, unchanged by this research.
