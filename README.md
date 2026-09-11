
## Deployment

GitHub Actions checks every branch on GitHub-hosted runners. A commit on `master` publishes one immutable GHCR image and deploys staging.

The production workflow promotes the exact image digest running on staging after approval. Nomad jobs live in `deploy/nomad`.
