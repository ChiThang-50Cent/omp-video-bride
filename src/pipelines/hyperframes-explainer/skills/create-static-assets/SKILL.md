---
name: create-static-assets
version: 1.0.0
description: Create and visually review reusable static character and environment assets from a brief, with consistent art direction and the requested output contract.
---

# Create static assets

Historical experiment prompts, outputs and skill snapshots are separate evidence, not defaults for new work.

## Scope

Create or reuse static character and environment artwork. Do not author shots, animation, audio or video, or change production routing unless requested. Reuse suitable supplied assets before creating replacements.

The skill defines a workflow, not an art style or character template. Do not impose humanoid anatomy, anthropomorphism, chibi proportions, clothing, facial features, a palette, outline treatment, pose, perspective or background layout.

## Resolve the brief

Read the user's request, relevant story context, supplied assets and project output conventions. Establish:

- What assets are needed, their identities and their role in the intended scene or standalone use.
- The requested art direction and any actual visual references. Distinguish required features from optional interpretation.
- Character body plan, defining features and behavior, where applicable; environment features and spatial relationships, where applicable.
- Output dimensions, format, transparency, framing, paths and expected viewing size.
- Placement, occlusion and text-safe regions only when the asset will be composed and those constraints apply.
- Available creation tools and the authorized generation/revision policy. Use the caller's model/tool settings; do not hard-code a provider, model or iteration count.

Use available context to resolve ordinary choices. Ask only when a missing decision materially changes identity, art direction or usability. State consequential interpretations before creating artwork. Keep subject-specific choices in the task brief, not in this skill.

## Output locations

Before creating or revising files, resolve the project root and the caller's asset-directory contract. Use the caller's required directories; do not invent a parallel layout. If the project root or required output location cannot be resolved from the brief or project conventions, ask before writing files.

New artwork, revised deliverables and review artifacts MUST stay inside the project root in their assigned output locations. Resolve every write path to an absolute path under that root; never treat the worker's current directory as the project root or write to a temporary/sibling directory as the final destination. Do not overwrite supplied originals.

For delegated work, the caller MUST supply the absolute project root and exact absolute output paths, including required previews or compositions. The worker MUST write to those paths and report the actual delivered paths. Project manifests MUST reference delivered assets using project-relative paths without absolute paths or `..` traversal.

## Establish a coherent design

Use the requested art direction across the asset set without making all subjects share the same shape or anatomy. Inspect supplied references visually; a text description is not evidence that an image was seen.

Before adding detail, resolve the large forms and relationships that make the subject readable:

- For a character, establish its silhouette, body structure and intended pose or state. Preserve the approved body plan and identity. Express personality through features or behavior appropriate to that subject; do not invent human traits to satisfy a checklist.
- For an environment, establish its composition, spatial logic and identifying features. Use perspective, abstraction or flat layout as required by the style, not a fixed room template.
- For assets intended to share a frame, agree their relative scale and visual hierarchy. Neither character-first nor background-first is mandatory; start with the reference or constraint that governs the others.

When these choices are uncertain or a redesign is needed, render a rough design for review before detailing it. A private plan is not a visually reviewed intermediate. Do not force extra variants or a separate approval turn when an existing approved design already resolves the choices.

## Produce the asset

Use the available creation method that fits the brief and output contract. Do not assume an image-generation service exists or that SVG suits every requested style. If a required capability is unavailable, name the missing capability rather than substituting another style silently.

Keep structure, overlap and interactions consistent with the design. Visibility is intentional: a feature may be occluded, absent or simplified when the subject, framing or style calls for it. Do not require every limb, both eyes, hands, clothing, grounded feet, full-body framing or asymmetry on every character.

Respect the requested separation of assets and alpha behavior. Do not bake a character into a reusable background or flatten assets together unless that is the requested deliverable. Add detail only when it supports identity, expression, spatial reading or the specified style.

## Review the actual output

Validate the file against its output contract, then render it in the target application. For browser-consumed SVG, inspect the browser rendering; for raster artwork, inspect the exported image. Source comments, object names and syntactic validity do not establish visual correctness.

Compare the rendered result with the brief at full size and intended viewing size:

- Are required identities, features and relationships recognizable?
- Do structure, attachment, overlap and interactions make sense for this subject and style?
- Are framing, visibility, hierarchy and detail appropriate for the intended use?
- Are dimensions, alpha behavior and file dependencies correct?

Apply only relevant checks. Physical weight/support matters when the scene implies it; symbolic, floating or abstract designs need not look grounded. A silhouette test is useful where shape conveys identity, not a universal requirement to recognize everything without color or context.

When assets are intended to be combined, compose a still with the exact files and expected placement. Inspect scale, readability, unwanted tangencies, occlusion and any reserved regions. Do not certify a pair from separate previews alone.

## Revise and deliver

Describe observed deviations before revising. Fix local defects locally; redesign the affected structure when the design itself fails. Do not lock a flawed design merely to minimize edits. Re-render and re-check the result after changes.

Follow the authorized revision policy. Preserve first outputs and corrections when required for a review experiment; disclose manual edits and tool changes. If a requirement remains unmet when revisions must stop, label it unmet rather than declaring the asset approved.

Deliver the requested files, dimensions and usable previews; include a composition when relevant. Record provenance and remaining limitations according to project conventions. Distinguish technical validity, visual review and user approval. Production use requires the project's approval process.

For local code-generated SVG, keep the asset static and self-contained: no executable content or remote dependencies. Apply further renderer/project restrictions from the output contract, not from a particular experiment.
