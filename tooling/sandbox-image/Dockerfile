# Verification image for arbitra's Docker sandbox (completion-plan P04).
#
# The sandbox runs checks with --network=none, a read-only root and a read-only
# snapshot mount, so every test dependency must already be in the image. arbitra
# never pulls or builds images; build this once, then reference it by digest:
#
#   docker build -t arbitra-sandbox-node tooling/sandbox-image
#   docker image inspect --format '{{.Id}}' arbitra-sandbox-node
#   -> image: "arbitra-sandbox-node@sha256:<that digest>"
#
# (With the containerd image store the image ID is the manifest digest. With the
# classic store, push to a local registry or use the RepoDigests entry instead.)
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# Test runners resolvable from any mounted snapshot without a node_modules of its own.
RUN npm install --global --no-fund --no-audit vitest@4.1.10 \
 && npm cache clean --force
ENV NODE_PATH=/usr/local/lib/node_modules \
    NO_COLOR=1 \
    CI=1
