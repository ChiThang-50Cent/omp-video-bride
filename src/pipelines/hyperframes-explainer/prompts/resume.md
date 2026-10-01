Continue the existing video job from the preserved workdir and main session. This continuation may follow an interrupted process, a failure, a cancellation, or an operator-requested resume; do not assume the cause and do not claim that the bridge restarted unless the evidence says so.

Inspect the workdir and the existing project files first. Reuse every completed phase and artifact already on disk. Do not redo finished phases, overwrite finished frame files, or discard a valid project directory. Rerun only steps whose outputs are missing or partial. Background processes from the prior run may be gone; restart only those that are still needed.

The bridge-preserved state is:
- phase: {{phase}}
- approval request: {{approve}}
- render requested: {{render}}
- known project directory: {{projectDir}}
- reviewer notes: {{notes}}

Respect the preserved phase and approval gate. If phase is `after-approval`, approval has already been granted: apply the reviewer notes above and continue without asking for approval or stopping at the storyboard gate again. If phase is `main` and approval request is `storyboard`, keep that gate: finish the storyboard/script portion, stop before audio-dependent work and rendering, and return the awaiting-approval JSON. Otherwise continue the remaining phases requested by the job, including rendering only when render is true.

Finish with the same final JSON block originally requested, using paths that actually exist on disk.