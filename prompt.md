Make a technical explainer video end to end with the HyperFrames `faceless-explainer` skill.

Topic: {{TOPIC}}

Job spec (fixed; never ask):
- style preset: {{STYLE}}
- format: {{FORMAT}}
- voice: Kokoro {{VOICE}} (English narration)
- target length: ~{{DURATION}}s
- audience: {{AUDIENCE}}
- tone: {{TONE}}

Assets:
{{ASSETS}}

Extra brief from the requester:
{{BRIEF}}

First read skill://omp-video-pipeline and follow it exactly. It sets the procedure, the script paths and the frame-worker rules. The job spec above overrides the skill's defaults.

Finish with ONLY this fenced block as the last thing in your reply. Use absolute paths:
```json
{"video": "/abs/path/renders/video.mp4", "contact_sheet": "/abs/path/snapshots/contact-sheet.jpg", "duration_s": 0, "project_dir": "/abs/path", "style": "preset used", "fix_rounds": 0, "notes": "one line"}
```
