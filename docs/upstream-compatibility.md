# Upstream compatibility

## Immutable revisions

| Dependency | Repository | Version | Revision |
|---|---|---|---|
| Pi | `earendil-works/pi` | `v0.85.0` | [`107d79f11072bbc8a3a757ed7fd69596bee7d68c`](https://github.com/earendil-works/pi/tree/107d79f11072bbc8a3a757ed7fd69596bee7d68c) |
| Switchyard | `tone4hook/Switchyard` | fork of `0.2.0` | [`2dd67d76ad12961f92359153e03686773e3e8761`](https://github.com/tone4hook/Switchyard/tree/2dd67d76ad12961f92359153e03686773e3e8761) |

The Switchyard revision is the head of
[`tone4hook/Switchyard#1`](https://github.com/tone4hook/Switchyard/pull/1)
and has NVIDIA NeMo Switchyard
[`9a743e89223a0d5b14011f1226d5b068f730a3b8`](https://github.com/NVIDIA-NeMo/Switchyard/tree/9a743e89223a0d5b14011f1226d5b068f730a3b8)
as its direct parent. It is a temporary compatibility fork. The
`switchyard-libsy` and `switchyard-protocol` Git dependencies are pinned to
the full fork revision above, never to a pull-request ref or branch.

Replace the fork only after an immutable NVIDIA NeMo Switchyard revision
provides an equivalent typed evidence API and passes the bridge compatibility
suite. Record that replacement explicitly in this file and
`config/upstream-lock.json`; do not silently follow an upstream branch.

## Capability evidence API

The fork preserves the existing `Algorithm::run_stream`, `Step`,
`RoutingOutcome`, `drive`, and `switchyard_llm_client::decide` behavior. It adds
an opt-in detailed result:

```rust
pub trait Decision: Send + Sync + 'static {
    fn as_any(&self) -> &dyn Any;
}

pub struct DetailedRoutingOutcome {
    pub outcome: RoutingOutcome,
    // Accessed through decision().
}

impl DetailedRoutingOutcome {
    pub fn decision(&self) -> Option<&dyn Decision>;
    pub fn into_outcome(self) -> RoutingOutcome;
}

pub async fn drive_with_decision<F, Fut>(
    algorithm: Arc<dyn Algorithm>,
    request: Request,
    serve: F,
) -> Result<DetailedRoutingOutcome>;

pub async fn decide_with_decision(
    algorithm: Arc<dyn Algorithm>,
    clients: ClientRouter,
    request: Request,
) -> Result<DetailedRoutingOutcome>;
```

The host downcasts `DetailedRoutingOutcome::decision()` to the public capability
decision type:

```rust
pub struct CapabilityClassifierDecision { /* private fields */ }

impl CapabilityClassifierDecision {
    pub const fn evidence(&self) -> CapabilityClassifierEvidence;
    pub const fn p_solve(&self) -> Option<f64>;
}

pub enum CapabilityClassifierEvidence {
    ValidatedVerdict { p_solve: f64 },
    Fallback { reason: CapabilityClassifierFallbackReason },
}

#[non_exhaustive]
pub enum CapabilityClassifierFallbackReason {
    InvalidVerdict,
}

impl CapabilityClassifierFallbackReason {
    pub const fn as_str(self) -> &'static str;
}
```

The types are exported by `switchyard-libsy`; the decision and evidence types
are also re-exported by `switchyard-runner`. The lab bridge should use
`switchyard-libsy` directly and continue fulfilling routing-time model calls
through Pi.

## Contract mapping

- `CapabilityClassifierEvidence::ValidatedVerdict { p_solve }` maps to a
  finite `RoutingDecision.weakSolveProbability`. Switchyard emits this variant
  only after its schema, semantic, and threshold-input validation accepts the
  verdict.
- `CapabilityClassifierEvidence::Fallback { reason: InvalidVerdict }` maps to
  `decisionSource: "classifier-fallback"`,
  `weakSolveProbability: null`, and fallback reason `invalid_verdict`.
- The selected model remains authoritative in
  `DetailedRoutingOutcome.outcome`. The adapter does not derive the target from
  `p_solve` or reproduce Switchyard threshold logic.
- Authentication, provider HTTP, transport, and stream decoding failures remain
  errors. They do not produce `InvalidVerdict` evidence and must not become a
  strong-tier classifier fallback.

Immutable source evidence:

- [`CapabilityClassifierEvidence` and `CapabilityClassifierDecision`](https://github.com/tone4hook/Switchyard/blob/2dd67d76ad12961f92359153e03686773e3e8761/crates/libsy/src/algorithms/llm_class.rs#L86-L143)
- [Library validation and evidence construction](https://github.com/tone4hook/Switchyard/blob/2dd67d76ad12961f92359153e03686773e3e8761/crates/libsy/src/algorithms/llm_class.rs#L270-L316)
- [`DetailedRoutingOutcome` and decision downcasting](https://github.com/tone4hook/Switchyard/blob/2dd67d76ad12961f92359153e03686773e3e8761/crates/libsy/src/core/algorithm.rs#L32-L65)
- [`drive_with_decision`](https://github.com/tone4hook/Switchyard/blob/2dd67d76ad12961f92359153e03686773e3e8761/crates/libsy/src/core/algorithm.rs#L312-L341)
- [Capability boundary, invalid-verdict, and provider-error tests](https://github.com/tone4hook/Switchyard/blob/2dd67d76ad12961f92359153e03686773e3e8761/crates/libsy/src/algorithms/llm_class.rs#L1136-L1267)
- [`decide_with_decision`](https://github.com/tone4hook/Switchyard/blob/2dd67d76ad12961f92359153e03686773e3e8761/crates/libsy-llm-client/src/run.rs#L127-L145)

This source evidence documents the API implemented by the pinned fork. Runtime
and integration behavior are covered separately by the automated test suite.

## Pi API mapping

The implementation pins the published `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, and `@earendil-works/pi-server` packages to `0.85.0`.
The package tag maps to the Pi revision above. Downshift uses these public
surfaces without copying their behavior:

| Lab operation | Pi-owned API | Immutable source |
|---|---|---|
| Create model/auth runtime and discover exact provider/model identities | `ModelRuntime.create`, `getModel`, `getAvailable`, `checkAuth` | [`model-runtime.ts` lines 172–220 and 388–420](https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/src/core/model-runtime.ts#L172-L220) |
| Login, refresh, and logout | `ModelRuntime.login`, `getAuth`, and `logout`; Pi performs refresh under the credential-store lock | [`model-runtime.ts` lines 472–529 and 681–695](https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/src/core/model-runtime.ts#L472-L529) |
| Classifier and coding provider calls | `ModelRuntime.completeSimple` and the session-created Pi stream function | [`model-runtime.ts` lines 631–645](https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/src/core/model-runtime.ts#L631-L645) |
| Select the native coding model before prompting | `AgentSession.setModel` | [`agent-session.ts` lines 1658–1688](https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/src/core/agent-session.ts#L1658-L1688) |
| Native tool loop, event stream, and compaction hook | `AgentSession.prompt`, `subscribe`, and `compact` | [`agent-session.ts` lines 1159–1255](https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/src/core/agent-session.ts#L1159-L1255) |
| New, resume/switch, fork, and clone lifecycle hooks | `AgentSessionRuntime.newSession`, `switchSession`, and `fork` | [`agent-session-runtime.ts` lines 196–293](https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/src/core/agent-session-runtime.ts#L196-L293) |
| Cross-process credential safety | Pi's file credential store and per-provider refresh serialization | [`auth-storage.ts` lines 116–194 and 442–485](https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/src/core/auth-storage.ts#L116-L194) |

The bootstrap calls the SDK session surface used by Pi's native interactive and
JSON modes. It does not add another UI or coding loop; `route-agent` exposes
those native runners through the container launcher.

## Provider compatibility matrix

| Capability | Fake Pi provider | Live Pi providers |
|---|---|---|
| Login mechanism | Mocked OAuth through `ModelRuntime.login` | Unverified; use each provider's native Pi `/login` flow |
| Container callback/code-paste | Not required by the mock flow | Unverified; callback reachability requires an explicit user-requested probe |
| Writable refresh persistence | Mocked and verified across restart | Unverified |
| Concurrent credential safety | Mocked and verified with two OS processes sharing one profile | Unverified |
| Native tool streaming | Mocked fragmented tool arguments, tool result continuation, finish, and usage through a registered Pi provider | Unverified per provider/model |
| Classifier JSON support | Schema instructions carried by Switchyard; mock returns complete text JSON | Native structured output and text-only fallback remain provider-specific and unverified |
| Model limits | Mock catalog reports 32,768 context and 4,096 output tokens | Must be read from Pi and compatibility-probed |
| Usage | Mock input/output counts verified through Pi | Provider-reported coverage unverified |
| Retry visibility | Lab passes `maxRetries: 0`; mock provider performs no retries | Native provider retry behavior must be verified before strict benchmark use |
| Login/logout | Mocked through Pi APIs and persisted/deleted by Pi | Unverified |

Automated runtime evidence is `mock`; it makes no credentialed, paid,
subscription, or live model request. Live rows require a separate, deliberate
interactive compatibility probe for the selected provider and model.
