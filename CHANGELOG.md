# Changelog

## 0.3.0 - 2026-10-20

### Features

- Add `ask --download-dir DIR` to save published deliverables alongside an answer.
- Add `download <run-uuid> --download-dir DIR` to retrieve files from an existing
  completed run without starting another question.
- Return absolute `local_path`, `download_status`, and per-file errors in JSON
  output, and show attachment locations in text output.

### Fixes

- Stream authenticated downloads with per-file timeouts and byte-size validation;
  reject external origins, redirects, unsafe paths, and overwrites.
- Remove incomplete files on failure while preserving the answer and successful
  downloads from the same batch.
- Handle duplicate, case-equivalent, Unicode-equivalent, and long filenames.

### Documentation

- Teach the Q&A Skill how to open local attachments, report failures, and retry
  existing runs while treating downloaded content as untrusted evidence.
- Document server compatibility: downloads require `Run.output_files` and Agent
  access to the private output-file endpoint. Existing Q&A use remains available
  on older servers; an explicit download request reports missing support.
- The CLI continues to send Bearer credentials without parsing JWTs, including
  the new server-managed Agent tokens.
