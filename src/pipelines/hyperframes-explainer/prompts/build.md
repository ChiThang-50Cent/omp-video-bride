Make a technical explainer video end to end with the HyperFrames `faceless-explainer` skill.

Topic: {{topic}}

Job spec (fixed; never ask):
- style preset: {{style}}
- format: {{format}}
- voice: Kokoro {{voice}} (English narration)
- target length: ~{{durationSec}}s
- audience: {{audience}}
- tone: {{tone}}

Flags:
- approve: {{approve}}
- render: {{render}}

{{paths}}

Assets:
{{assets}}

Extra brief from the requester:
{{brief}}

First read skill://omp-video-pipeline and follow it exactly. The job spec above overrides the skill's defaults.

Finish with ONLY this fenced block as the last thing in your reply. Use absolute paths:
```json
{"video": "/abs/path/renders/video.mp4", "contact_sheet": "/abs/path/snapshots/contact-sheet.jpg", "duration_s": 0, "project_dir": "/abs/path", "style": "preset used", "fix_rounds": 0, "notes": "one line"}
```
