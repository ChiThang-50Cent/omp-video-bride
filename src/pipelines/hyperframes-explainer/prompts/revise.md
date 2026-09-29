Revise an existing HyperFrames `faceless-explainer` video. It was already built and rendered. PROJECT_DIR below is a fresh copy of it (without renders and snapshots), so edit it in place.

PROJECT_DIR: {{projectDir}}

Change request from the requester:
{{instructions}}

Frames the requester pointed at (numbers match the contact sheet): {{frames}}

Video length: {{duration}}

{{paths}}

Assets:
{{assets}}

First read skill://omp-video-pipeline and follow its **Revise mode** section exactly. It overrides the full-build phases.

Finish with ONLY this fenced block as the last thing in your reply. Use absolute paths:
```json
{"video": "/abs/path/renders/video.mp4", "contact_sheet": "/abs/path/snapshots/contact-sheet.jpg", "duration_s": 0, "project_dir": "/abs/path", "change_class": "visual|captions|narration|duration|restructure", "frames_changed": [0], "fix_rounds": 0, "notes": "one line: what changed"}
```
