# BCI + AI Accessibility Browser — Product & Research Specification

> Working thesis: A browser should not require a high-bandwidth brain signal. A BCI can
> express sparse, uncertain intent; an AI agent can translate that intent into safe,
> auditable, multi-step web actions.

- **Version:** 0.1
- **Date:** 9 August 2026
- **Status:** Concept / research framing
- **Recommended academic framing:** Master's-level research, with an Honours-sized MVP as Phase 1

This file is a faithful markdown transcription of the original spec
(`BCI_AI_Accessibility_Browser_Product_Research_Spec_v0.1.docx`), kept in the repo as the
source of truth the codebase should track. If the two diverge, treat the `.docx` supplied
by the product owner as canonical and update this copy.

## 1. Executive Summary

This specification proposes an accessibility-first Chromium-based browser in which a
brain-computer interface (BCI) provides a low-bandwidth intent signal and an AI/LLM agent
converts that intent into high-level browser actions. The design deliberately avoids
treating neural input as a replacement mouse or keyboard. Instead, it treats neural input
as an intent and authorization channel.

The central research opportunity is the mediation layer between an uncertain neural
decoder and an autonomous software agent: how should sparse intent, confidence, context,
confirmation, safety policy and browser state be combined so that a user can complete web
tasks with fewer interactions and lower effort, without allowing false neural
classifications or malicious page content to cause harmful actions?

**Why this is timely:** Recent research demonstrates long-term independent computer
control with implanted BCIs; non-invasive EEG systems are improving; EEG-to-LLM and
privacy-preserving EEG-to-text pipelines are now appearing; and research has begun to
explicitly examine security risks when BCI outputs authorize tool-using LLM agents. Apple
has also announced BCI support through Switch Control, indicating that mainstream
accessibility platforms are preparing for BCI input. [1–5]

## 2. Problem Statement

People with severe motor impairments can face high interaction costs when conventional
assistive interfaces require repeated dwell selections, switch scanning, cursor movement
or character-by-character entry. BCIs may restore a path to digital control, but
especially for non-invasive EEG, the signal is noisy and bandwidth is limited. Directly
mapping that signal to every low-level browser operation can therefore remain slow and
cognitively demanding.

Large language model agents create a different interaction model: a small amount of user
intent can be expanded into a plan containing many browser actions. The research problem
is therefore not "Can EEG read arbitrary thoughts?" but "Can reliable low-bandwidth neural
intent, combined with contextual AI planning and explicit confirmation, reduce the number
of user interactions needed to complete common web tasks?"

## 3. Product Vision and Principles

- **Intent over mechanics:** capture what the user wants, not every cursor movement required to achieve it.
- **Accessibility-first:** support users with severe motor limitations as the primary design case, not as an afterthought.
- **BCI-agnostic input:** define a device adapter interface so EEG, implanted BCIs, eye tracking, switches, EMG or simulated inputs can all feed the same intent protocol.
- **Local neural privacy:** raw neural signals should remain on-device wherever technically feasible; the agent should receive only derived intent or semantic cues.
- **Confidence-aware execution:** uncertainty must be a first-class data type. Low-confidence intent should trigger clarification rather than action.
- **Risk-proportionate confirmation:** harmless navigation may be automatic; communications, purchases, deletion and financial actions require stronger confirmation.
- **Auditable agent behavior:** every action should record intent source, confidence, interpreted goal, page context, tool call and confirmation state.

## 4. Scope

| In scope for MVP | Out of scope for MVP |
|---|---|
| Chromium/Electron or Chromium-controlled browser shell | Developing a new EEG headset or implant |
| BCI adapter API and simulated neural input | Open-ended "mind reading" or arbitrary thought reconstruction |
| Optional off-the-shelf non-invasive EEG integration | Medical diagnosis or therapeutic claims |
| LLM planner that turns intent into browser goals/actions | Autonomous high-risk financial transactions |
| Accessibility-tree/DOM based web interaction | Replacing all OS-level assistive technology |
| Confirmation, undo, stop and safety policies | Clinical validation without ethics approval |
| Evaluation against direct low-level control baselines | Claiming universal performance across disabilities |

## 5. Target Users and Usage Modes

Primary target users are people who cannot reliably use conventional mouse, keyboard or
touch input because of severe motor impairment. The system should also support
progressive impairment and mixed-input use, where a person combines neural intent with
eye tracking, switch control, speech or residual movement.

| Mode | Input example | Role in system |
|---|---|---|
| BCI-only | EEG/implant provides select, cancel, yes/no, directional or semantic intent | Maximum hands-free independence |
| BCI + gaze | Gaze identifies target; BCI confirms action | Reduces spatial ambiguity |
| BCI + switch | BCI expresses goal; switch confirms high-risk action | Strong safety/authorization channel |
| BCI + voice | Speech supplies text when available; BCI remains fallback | Progressive-accessibility mode |
| Simulated BCI | Keyboard/gamepad emits intent events with injected confidence/error | Research and software testing before human EEG trials |

## 6. Core User Stories

- As a user, I can express a goal such as "YouTube, AVGN, season 9" and have the agent locate and start the relevant content after an appropriate confirmation.
- As a user, I can stop the agent immediately using a highly reliable cancel signal.
- As a user, I can ask the system what it believes I intend before it acts.
- As a user, I can approve or reject a proposed action using a binary neural or switch signal.
- As a user, I can recover from an incorrect interpretation without navigating backward through many low-level steps.
- As a user, I can use the system without sending raw EEG recordings to a cloud LLM.
- As a researcher, I can replay anonymized intent events and agent traces to measure false actions, task success, latency and confirmation overhead.

## 7. Example Interaction

```
Neural decoder output
  concept: ["YouTube", "AVGN", "season 9"]
  command: EXECUTE_GOAL
  confidence: 0.84

Agent interpretation
  goal: "Open YouTube and play the AVGN Season 9 playlist"
  risk: LOW

Browser executor
  1. Navigate to youtube.com
  2. Search for AVGN Season 9
  3. Resolve likely playlist / official result
  4. Present proposed target
  5. On confirmation, start playback
```

**Key design choice:** The neural decoder does not need to produce a perfect
natural-language sentence. It can emit structured concepts plus a small command
vocabulary. The LLM turns that sparse representation into an operational plan.

## 8. High-Level Architecture

| Layer | Responsibility | Candidate technology |
|---|---|---|
| 1. Input adapters | Normalize EEG, implant, gaze, switch, EMG or simulated events | Python/C++ device SDKs; WebSocket/gRPC bridge |
| 2. Signal/intent decoder | Filter signal, classify intent, estimate confidence | Python, MNE, PyTorch/scikit-learn; device-native decoder |
| 3. Intent broker | Convert decoder outputs to a stable device-neutral schema | TypeScript service |
| 4. Context composer | Combine intent with focused tab, accessibility tree, history and user state | Node/TypeScript |
| 5. LLM planner | Infer goal, plan steps, ask clarification where needed | Local or cloud LLM with tool calling |
| 6. Safety/authorization | Risk scoring, provenance, confirmations, policy enforcement | Deterministic policy engine |
| 7. Browser executor | Read page semantics and perform actions | Chrome DevTools Protocol / Playwright / Electron |
| 8. Feedback UI | Show inferred intent, confidence, progress, stop/undo | React + accessible Chromium UI |
| 9. Audit/evaluation | Record structured traces and research metrics | Local encrypted event store |

Chromium exposes a dedicated Accessibility domain through the Chrome DevTools Protocol,
including access to complete or partial accessibility trees and queries by accessible
name and role. CDP also exposes browser instrumentation and input/DOM capabilities,
making a Chromium-controlled proof of concept feasible without initially forking the
browser engine. [6–7]

## 9. Intent Event Contract

```json
{
  "source": "eeg.openbci",
  "intent": "EXECUTE_GOAL",
  "concepts": ["youtube", "avgn", "season 9"],
  "confidence": 0.84,
  "timestamp": "2026-08-09T22:00:00+02:00",
  "requires_confirmation": false,
  "signal_provenance": {
    "decoder": "motor-imagery-v1",
    "session": "local-session-id"
  }
}
```

The contract should deliberately separate raw neural data from semantic intent. This
allows BCI vendors to provide their own decoding while the browser consumes a stable,
low-risk interface.

## 10. Agent Execution Model

| Risk tier | Examples | Default behavior |
|---|---|---|
| Tier 0 — Observe | Read page, summarize, inspect accessibility tree | No confirmation |
| Tier 1 — Reversible navigation | Open tab, search, play/pause media, scroll | Automatic above confidence threshold |
| Tier 2 — Communication | Send message, submit form, post content | Preview + explicit confirmation |
| Tier 3 — Consequential | Purchase, account deletion, change permissions | Strong confirmation; preferably independent channel |
| Tier 4 — Prohibited/unsupported | Unbounded financial transfer or unsafe action | Refuse or require external trusted workflow |

A 2026 route-safety study specifically argues that BCI-to-agent pipelines create a new
authorization attack surface: both neural decoding errors/perturbations and malicious
context can alter tool routing. This makes provenance, confirmation and audit logging
core architecture rather than optional polish. [5]

## 11. Safety, Privacy and Security Requirements

- Raw neural data remains local by default. Cloud services receive only allowlisted semantic intent, confidence and the minimum page context required for planning.
- The system must maintain a deterministic "STOP" pathway that bypasses the LLM.
- The agent must never treat webpage text as authorization. Page content is untrusted context, not user intent.
- High-risk actions require confirmation captured after the final action parameters are known.
- A second confirmation channel should be supported where possible (switch, gaze dwell, BCI confirmation decoder, caregiver-approved mechanism).
- Audit logs must distinguish neural-source events, LLM interpretation, external webpage content and executed browser actions.
- Confidence thresholds should be calibrated per user/session and may differ by action risk.
- Users must be able to pause neural control and inspect/delete stored neural-derived history.
- Research builds should use explicit consent, de-identification and ethics approval for human neural data.

## 12. Accessibility UX Requirements

- Large, persistent display of current interpreted intent and whether the system is listening, paused, planning or acting.
- No confirmation timeout that silently accepts an action; timeout should cancel or remain pending.
- Low cognitive-load choices: normally 2–4 alternatives rather than long menus.
- Every automated step should be interruptible.
- Support screen readers, zoom, high contrast, switch scanning, eye tracking and keyboard input even when BCI is active.
- Avoid modal traps and interfaces that require fine pointer placement.
- Provide "Explain what you are about to do" and "Undo last reversible action" commands.

Apple's 2025 accessibility roadmap explicitly announced a protocol allowing BCIs to
operate Switch Control for users with severe mobility disabilities, supporting the
broader product assumption that BCI input should integrate with established assistive
interaction patterns rather than replace them. [4]

## 13. MVP Technical Plan

1. Build the browser agent before integrating live EEG. Use Electron or a controlled Chromium instance and implement semantic page interaction using CDP/accessibility-tree data.
2. Define the Intent Event Contract and create a simulated BCI adapter that produces commands, concept tokens, confidence values and controllable error rates.
3. Implement a deterministic safety gateway between the LLM planner and browser tools.
4. Implement confirmation, stop, undo and intent-preview UX.
5. Create a benchmark suite of accessibility-oriented browser tasks such as media navigation, search, form completion and information retrieval.
6. Integrate one off-the-shelf non-invasive EEG device for a small command vocabulary (for example left/right/select/cancel, motor imagery or SSVEP depending hardware and ethics constraints).
7. Only after software reliability is established, evaluate with human participants under approved research protocols.

## 14. Suggested Software Stack

| Area | Recommended starting point | Reason |
|---|---|---|
| Browser shell | Electron + Chromium, or Playwright-controlled Chromium | Avoid maintaining a Chromium fork during research |
| UI | React + TypeScript | Fast accessible UI iteration |
| Agent service | Node.js / TypeScript | Natural fit with browser tooling and tool schemas |
| BCI processing | Python | Strong EEG/neuroscience/ML ecosystem |
| Inter-process bridge | WebSocket or local gRPC | Separates neural pipeline from browser process |
| Local storage | SQLite / encrypted event log | Simple reproducible research traces |
| ML | PyTorch / scikit-learn | Flexible intent classifiers |
| Research analysis | Python/pandas/stats tooling | Repeatable evaluation pipeline |

> **This repo's starting point:** Playwright-controlled Chromium (the "avoid a Chromium
> fork" branch of the table above), Node.js/TypeScript for the agent/safety/executor
> services, and a browser-based feedback UI. See `docs/architecture.md` for how the
> code maps onto this table.

## 15. Evaluation Framework

The research should compare interaction models rather than merely report that the
prototype works. A strong experiment can hold browser tasks constant while changing the
control strategy.

| Condition | Description |
|---|---|
| A. Direct control baseline | Each selection or browser action requires an explicit switch/BCI-like event. |
| B. Agentic intent control | One sparse goal plus confirmations allows the agent to perform multiple reversible steps. |
| C. Agentic + uncertainty policy | Same as B, but confidence-aware clarification and stronger high-risk confirmation are enabled. |

Primary measures: task success rate; time to completion; number of user-issued control
events; false action rate; correction count; agent steps per user command; confirmation
burden; interruption recovery time; and end-to-end latency. Secondary measures can
include usability, cognitive workload and perceived autonomy.

**Research value:** The key dependent variable is not EEG classification accuracy alone.
The system can be valuable even with modest decoder bandwidth if an agent converts a
small number of reliable intents into successful, safe task completion.

## 16. Research Questions and Hypotheses

**Primary research question**

- **RQ1:** To what extent can an AI-mediated browser agent reduce the number of deliberate control events required to complete web tasks when user input is constrained to sparse, uncertain BCI-style intent signals?

**Supporting research questions**

- **RQ2:** How should decoder confidence influence clarification, confirmation and autonomous execution thresholds?
- **RQ3:** Does accessibility-tree-grounded browser control reduce agent execution errors compared with visually inferred or coordinate-based interaction?
- **RQ4:** What confirmation policy best balances task speed, autonomy and false-action risk?
- **RQ5:** Can raw neural data remain local while semantic intent sent to an LLM remains sufficient for useful agent behavior?

**Candidate hypotheses**

- **H1:** Agentic intent control will require significantly fewer deliberate control events per successful task than direct low-level control.
- **H2:** Confidence-aware confirmation will reduce false consequential actions relative to a fixed-threshold agent without materially reducing success on low-risk tasks.
- **H3:** Structured semantic intent (commands + concept tokens) will achieve comparable task success to free-form decoded text for a defined set of browser tasks, while requiring less neural decoding bandwidth.

## 17. Honours vs Master's Scope

| Dimension | Honours-sized version | Master's-sized version |
|---|---|---|
| Research objective | Demonstrate and evaluate feasibility | Develop and defend a novel mediation/safety architecture |
| BCI input | Simulated BCI and/or small off-the-shelf EEG command set | Live BCI plus calibrated uncertainty; potentially multimodal input |
| Agent | Limited set of browser tasks | Generalized task planner with risk-aware policy and provenance |
| Evaluation | Small controlled study; prototype metrics | Comparative experimental study with statistical analysis and stronger external validity |
| Novelty | Integration and empirical feasibility | Original model/architecture/policy, grounded against literature and baselines |
| Security/privacy | Design discussion + basic controls | Explicit threat model, route-safety evaluation, local/privacy architecture |
| Output | Research report + prototype | Dissertation + reproducible prototype + publishable study potential |

**Recommendation:** Treat the complete concept as a Master's topic. If you are currently
doing Honours, build the browser-side architecture, simulated BCI protocol and a tightly
scoped evaluation as the Honours project; then extend it into live BCI integration,
uncertainty calibration, multimodal confirmation and a stronger user study at Master's
level.

In the South African framework, Bachelor Honours qualifications are at NQF Level 8,
while Master's qualifications are at NQF Level 9. Registered Master's qualifications
commonly require independent research, current literature engagement, an appropriate
research design, analysis and a dissertation-level contribution. [8–9]

## 18. What Would Make It Genuinely Master's-Level?

- A clearly articulated gap: existing BCI systems often emphasize direct communication/control, while the proposed work investigates sparse neural intent as input and authorization for an autonomous browser agent.
- A novel artifact or method: for example, a Neural Intent Mediation Layer that combines intent semantics, confidence, browser context, provenance and risk tiering.
- An explicit model of uncertainty and confirmation rather than a simple "EEG classifier calls LLM" demo.
- A comparative evaluation with baselines and statistically defensible analysis.
- A security/privacy contribution, particularly protection against prompt injection and false neural authorization.
- Reproducibility: documented protocol, test tasks, simulated BCI error model, agent traces and code where ethics/IP permit.
- A discussion that separates what was learned about human-computer interaction from what merely happened to work in the implementation.

## 19. Potential Dissertation Title

**Recommended working title:** "From Neural Intent to Web Action: A Confidence-Aware
BCI–LLM Architecture for Accessible Agentic Browsing"

**Alternative:** "Reducing Interaction Burden in Accessible Web Computing Through Sparse
Neural Intent and LLM-Based Browser Agents."

## 20. Proposed Contribution Statement

This research proposes and evaluates a device-agnostic mediation architecture that
transforms sparse, confidence-scored neural intent into safe, auditable browser-agent
actions. Rather than optimizing solely for high-bandwidth neural decoding, the approach
investigates whether agentic task completion can compensate for low input bandwidth
while preserving user authorization through confidence-aware confirmation and
provenance-aware execution.

## 21. Research Method Sketch

1. Literature review: BCI control, assistive HCI, EEG decoding, agentic web interaction, accessibility trees, LLM tool use, neural privacy and prompt-injection safety.
2. Design science / artifact construction: build the mediation layer and browser prototype.
3. Controlled evaluation: compare direct low-level control with agentic intent control across a defined task suite.
4. Quantitative analysis: task success, time, control-event count, false actions, latency and correction burden.
5. Qualitative analysis: perceived control, trust, cognitive burden and usability through interviews/questionnaires where approved.
6. Threat/safety evaluation: inject decoder uncertainty and adversarial webpage context; measure whether safety gates prevent unauthorized routes.
7. Iterate design based on results and document limitations, especially generalizability from simulated BCI or non-clinical participants.

## 22. Ethics and Study Design Notes

A software-only or simulated-BCI phase is substantially easier to start because it can
test the core HCI hypothesis without collecting neural data. Live EEG introduces
human-participant, privacy and data-governance considerations. Recruiting people with
severe disabilities introduces additional accessibility, consent, fatigue, caregiver and
clinical-partner considerations. Those are appropriate for a carefully supervised
Master's study but may be excessive for an initial Honours timeline.

A sensible progression is therefore: simulated BCI → healthy-participant/off-the-shelf
EEG feasibility → co-design or evaluation with target accessibility users, subject to
institutional ethics approval and appropriate supervision.

## 23. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| EEG intent accuracy is too low | Unusable live demo | Keep research focused on sparse commands; use simulation to evaluate software layer independently |
| LLM acts on wrong interpretation | Loss of trust / unsafe action | Intent preview, confidence gates, reversible execution, explicit high-risk confirmation |
| Prompt injection from webpage | Agent route hijack | Treat page text as untrusted; deterministic policy layer; provenance-aware tool authorization |
| Latency becomes frustrating | Poor accessibility experience | Local intent decoder; streaming planning; minimize model calls; precompute page semantics |
| Chromium fork becomes too large | Project scope explosion | Start with Electron/CDP; fork only if research requires browser-engine changes |
| Human-subject recruitment difficult | Insufficient study sample | Design a valid simulated-BCI experiment first; add clinical participants only with partners/ethics approval |

## 24. Milestones

| Milestone | Definition of done |
|---|---|
| M1 — Agentic browser core | LLM can navigate a controlled task set using accessibility-tree-grounded actions with stop/undo. |
| M2 — Intent abstraction | Simulated BCI emits structured intents, concepts and confidence into the browser. |
| M3 — Safety gateway | Risk tiers, confirmations, provenance and audit traces enforced independently of the LLM. |
| M4 — Baseline experiment | Direct-control vs agentic-control benchmark runs reproducibly. |
| M5 — Live BCI proof | At least one off-the-shelf BCI can issue a small reliable command vocabulary. |
| M6 — Research evaluation | Study and analysis answer the primary research question and document limitations. |

## 25. Success Criteria

- Users can complete representative browser tasks with fewer deliberate control events than a direct-control baseline.
- False high-risk actions are prevented by the safety/confirmation layer in the evaluated scenarios.
- The system remains usable when intent confidence is imperfect and can recover from misclassification.
- Raw EEG is not required to leave the local decoder pipeline for the agent to operate.
- The architecture supports at least two input adapters (for example simulated BCI + live EEG or switch).
- The research produces a defensible answer about when AI mediation helps, not merely a feature demonstration.

## 26. Current Research Positioning

The concept sits at the intersection of four active areas: assistive BCI,
neural-to-language interfaces, LLM agents and accessible browser automation. Current
evidence supports each individual layer, but there remains room for research on the
end-to-end mediation problem.

- **Long-term assistive computer control:** a 2026 Nature Medicine study reported near-daily independent at-home use of an intracortical BCI for speech and cursor control over nearly two years, including internet browsing. [1]
- **Non-invasive BCI progress:** 2025 work demonstrated real-time EEG-based decoding for individual finger control, showing continued gains in non-invasive control precision. [2]
- **Brain–LLM interfaces:** 2026 work used EEG-derived satisfaction to guide LLM/generative output, explicitly motivated by users who may not reliably provide normal linguistic input. [3]
- **Privacy-preserving EEG-to-text:** SENSE proposes local EEG-to-semantic extraction where only derived textual cues reach the LLM. [10]
- **BCI-agent security:** 2026 work on "brain-prompt injection" treats decoded neural activity as an authorization channel for tool-use agents and argues for route-level provenance and confirmation. [5]
- **Mainstream accessibility:** Apple announced BCI support through Switch Control for iOS, iPadOS and visionOS. [4]
- **Browser control substrate:** Chromium's DevTools Protocol exposes accessibility-tree, DOM and instrumentation interfaces suitable for semantic agent control. [6–7]

**Novelty warning:** The field is moving quickly. Before formal proposal submission, run
a fresh systematic literature search to verify that no closely equivalent "BCI intent →
LLM tool agent → autonomous browser" system has appeared. The research contribution
should be defined by measurable architecture/evaluation claims, not by relying only on
being first.

## 27. Reference Starting Set

1. Card et al. (2026). Long-term independent use of an intracortical brain–computer interface for speech and cursor control. *Nature Medicine.*
2. Ding et al. (2025). EEG-based brain-computer interface enables real-time robotic finger control. *Nature Communications.*
3. Zhang et al. (2026). EEG-Based Brain-LLM Interface for Human Preference Aligned Generation. arXiv:2603.16897.
4. Apple (2025). Accessibility features: protocol support for Brain Computer Interfaces through Switch Control.
5. Tai (2026). Brain-Prompt Injection: A Route-Safety Audit for BCI–LLM Agents. arXiv:2606.09315.
6. Chrome DevTools Protocol — Accessibility domain.
7. Chrome DevTools Protocol — Overview.
8. South African Qualifications Authority (SAQA). Example Level 9 Master's qualification with dissertation/research outcomes.
9. SAQA. Example Master's qualification: independent research, current literature, research design and dissertation outcomes.
10. Murhekar et al. (2026). SENSE: Efficient EEG-to-Text via Privacy-Preserving Semantic Retrieval. arXiv:2603.17109.

## 28. Recommended Next Step

Turn this specification into a 2–4 page formal research concept note containing:
background; problem statement; research gap; primary research question; proposed
artifact; methodology; evaluation plan; ethical considerations; expected contribution;
and a short literature review. For a Master's application, the proposal should emphasize
the research contribution and evaluation rather than presenting the work primarily as a
commercial browser product.

**One-sentence pitch:** Build and evaluate a confidence-aware accessibility browser that
lets low-bandwidth BCI signals express user intent while an LLM agent safely performs the
multi-step web interaction.
