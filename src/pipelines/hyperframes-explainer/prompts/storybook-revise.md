Revise the existing character-led 2D storybook film in place. This project is already copied into the new job workdir. Do not switch to technical-explainer conventions, re-plan unchanged shots, replace suitable character/background files unless the requested revision changes their design, or discard finished assets.

Absolute PROJECT_DIR: {{projectDir}}
Bridge-approved current contract: {{contract}}
STORYBOOK_SCRIPTS: {{storybookScripts}}
OUR_SCRIPTS: {{ourScripts}}
{{paths}}

Requested change:
{{instructions}}

Affected contact-sheet frame numbers: {{frames}}
Duration: {{duration}}

Assets:
{{assets}}

Read skill://omp-storybook-pipeline and its revision procedure. Apply the new production contract while retaining reusable character/background files, identities, source hashes and whole-image bottom-center pivots unless the requested revision changes their design. Inventory missing or affected artwork; use skill://create-static-assets only for the assets that need creation or revision, with the actual references, absolute paths and storybook output contract. Require any delegated asset worker to read that skill and use caller-configured tools/model. Narration/caption-only revisions must not regenerate suitable artwork. Touch only affected shots or requested artwork. Inspect the exact changed assets in a still composition before changing motion; then use sparse whole-image slide/tilt transforms only over measured narration/word spans, returning to neutral when each utterance ends. Do not rock through silent padded time; stationary characters remain valid. Keep flat outlined art, subject-appropriate defining features/body plan/palette/proportions and readable caption-safe staging consistent across shots that reuse changed assets. Do not impose human traits or add alternate manifest fields/placeholders. Changed narration uses the shared measured audio CLI and cache; never cut speech. Recompile with compileProject via compile-scene.mjs, refresh source-bound visual review and acceptance evidence, then render once. Missing or stale acceptance is a failure, not a note to hide in a successful result.

Finish with ONLY this fenced block as the last thing in your reply. Use absolute paths:
```json
{"video":"/abs/project/renders/video.mp4","contact_sheet":"/abs/project/snapshots/contact-sheet.jpg","duration_s":0,"project_dir":"/abs/project","change_class":"visual|captions|narration|duration","frames_changed":[0],"fix_rounds":0,"notes":"actual verification and changes"}
```