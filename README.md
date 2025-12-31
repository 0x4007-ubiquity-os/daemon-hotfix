# daemon-hotfix

UbiquityOS daemon that triages plugin failures and creates/upserts issues (optionally PRs) with safety guardrails.

This repo is designed to be invoked by the UbiquityOS Kernel via `workflow_dispatch` (see `.github/workflows/compute.yml`).

