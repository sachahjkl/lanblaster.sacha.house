
## Deployment

GitHub Actions checks pull requests and accepted `master` commits on `ubuntu-latest`. An accepted commit publishes one immutable GHCR image.

The production workflow promotes the exact image digest running on staging after approval. Nomad jobs live in `deploy`.
