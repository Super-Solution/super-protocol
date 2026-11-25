//! The agent loop as a sans-IO state machine, and the tool-argument repair a driver runs before it.
//!
//! No clock, no ids, no network, no async, no model, no tools: the machine is fed *inputs* and answers with
//! *events* and *effects*; a driver does the effects. The rules are in `docs/AGENT-LOOP.md` of Super Protocol
//! and are pinned by `conformance/agent-loop.v0.json` and `conformance/tool-repair.v0.json`, which this crate's
//! tests read. Everything crossing the boundary is `serde_json::Value` on purpose: the conformance file is the
//! contract, and typed wrappers are a later, separate decision.
//!
//! Status: not published. `publish = false` until the owner decides (see the go/no-go note in the repository).

mod machine;
mod repair;

pub use machine::{
    is_user_decline, IllegalInput, LoopMachine, Step, CHECKPOINT_VERSION, USER_DECLINED,
};
pub use repair::{normalize_tool_name, repair_tool_arguments, RepairResult};
