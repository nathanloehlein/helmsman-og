# Agent stage image

Build from the Helmsman root:

```sh
docker build -t helmsman/moonunit-adoption:test -f docker/helmsman-runtime/Dockerfile .
```

This image contains pinned provider CLIs, Git, and a read-only scoped `gh` shim. It contains no Helmsman database, host credentials, or publication authority. Helmsman keeps orchestration and publication on the host and mounts only each stage's workspace, runtime outputs, and pinned skills.

See `docs/docker-run-host.md` for configuration, network behavior, validation, and limits. The two provider CLIs require API credentials configured at the host gateway; host subscription login state is never copied into the image.
