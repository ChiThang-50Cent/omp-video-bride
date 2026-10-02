Produce a complete narrated 2D storybook film with the HyperFrames renderer. This is character-led storytelling, NOT a technical explainer, infographic, slideshow, or a set of labeled motion-design cards.

Topic: {{topic}}

Production contract:
- direction: {{style}} — flat outlined cartoon art, readable staging, coherent palette, and warm scene lighting
- format: {{format}}
- voice: Kokoro {{voice}}, English
- total duration: {{durationSec}}s
- audience: {{audience}}
- tone: {{tone}}
- narration mode: {{narrationMode}}
- music: {{music}}
- storyboard approval gate: {{approve}}
- render: {{render}}

Absolute PROJECT_DIR: {{projectDir}}
Bridge-approved contract: {{contract}}
STORYBOOK_SCRIPTS: {{storybookScripts}}
OUR_SCRIPTS (shared audio/font/frame verification tools): {{ourScripts}}
{{paths}}

Assets:
{{assets}}
Only uploaded/selected assets are available. A localProjectDir in metadata does not transfer files. Copy selected reusable assets into PROJECT_DIR; never modify originals. Prefer supplied or already available reusable artwork. If new artwork is authorized, create it only with an available authorized tool; never invent fake placeholders or assume a paid provider.

Approved brief:
{{brief}}

First read skill://omp-storybook-pipeline, skill://create-static-assets, skill://hyperframes-core and skill://hyperframes-animation. Follow the storybook procedure, not faceless-explainer authoring conventions. Copy the bridge-approved production-contract.json into PROJECT_DIR unchanged before authoring. Settle STORYBOARD.md and SCRIPT.md first and honor any requested storyboard gate before asset generation. Then inventory the whole film's required assets, reuse suitable supplied files, and follow create-static-assets for missing or changed artwork. If delegation is needed, give one asset worker the coherent set, exact absolute paths, actual reference files, required identities/features, caller-authorized tools/revision policy and the storybook output contract; require that worker to read the skill. Do not generate recurring characters independently per shot or hard-code an anatomy/model into the generic skill. Inspect a real-browser still made with the exact asset files and expected staging before motion. Preserve subject-appropriate defining features, body plan and intended framing; use whole-image bottom-center pivots and a coherent full-frame background. Reuse those exact files in every shot and bind their source hashes.

Use the supported storybook.json manifest only: root `characters` and `backgrounds`, local PNG/WebP/SVG paths, positive authored character width/height, and shots whose cast entries refer to a character/background by ID. Cast coordinates are bottom-center canvas anchors. Keep motion sparse: a whole character image may slide with finite x/y offsets and tilt by a small rotation during its measured narration/word span, then return to neutral when that utterance ends; absent motion means completely still. Do not rock or tilt through silent padded time. Do not add alternate schema fields. The entire backdrop comes from its selected background asset. After the still frame is approved internally for readability and continuity, create the native paused GSAP timeline and deterministic seek behavior that drives the actual encoded transforms and caption wrapper. This visual review is internal and does not create an extra user approval gate; honor only the requested storyboard approval gate above.

Dispatch each worker with exact ABSOLUTE input/output paths; workers inherit the job workdir, not PROJECT_DIR. Create output directories before dispatch. Recover misplaced existing output instead of rebuilding whole batches. Run centralized gates after all assigned artifacts exist.

Verbatim means approved spoken text is unchanged. Required music means a real quiet music bed. Measure audio and preserve every word; never trim speech to force a beat. Inspect actual motion and final rendered media, not just one midpoint still. Acceptance must bind current sources/assets and include machine checks plus explicit visual review evidence. A rendered file alone is not completion. Resolve failed/missing requirements; do not report success by writing an unverified boolean.

If approve is storyboard, stop after storyboard/script and before asset generation, audio or frame production. After approval, reuse existing suitable assets and complete any missing or affected artwork with create-static-assets before motion. If render is false, produce the audited preview and contact sheets without MP4. Otherwise finish the MP4, contact sheets, transcript/subtitles, source assets and acceptance evidence.

Finish with ONLY this fenced block as the last thing in your reply. Use absolute paths:
```json
{"video":"/abs/project/renders/video.mp4","contact_sheet":"/abs/project/snapshots/contact-sheet.jpg","duration_s":0,"project_dir":"/abs/project","style":"storybook-flat","fix_rounds":0,"notes":"actual verification and any explicitly accepted limitations"}
```