# spaday-perspective

[Perspective](https://perspective-dev.github.io) for [spaday](https://1kbgz.github.io/spaday/)

[![Build Status](https://github.com/1kbgz/spaday-perspective/actions/workflows/build.yaml/badge.svg?branch=main&event=push)](https://github.com/1kbgz/spaday-perspective/actions/workflows/build.yaml)
[![codecov](https://codecov.io/gh/1kbgz/spaday-perspective/branch/main/graph/badge.svg)](https://codecov.io/gh/1kbgz/spaday-perspective)
[![License](https://img.shields.io/github/license/1kbgz/spaday-perspective)](https://github.com/1kbgz/spaday-perspective)
[![PyPI](https://img.shields.io/pypi/v/spaday-perspective.svg)](https://pypi.python.org/pypi/spaday-perspective)

## Overview

`spaday-perspective` moves the existing `PerspectivePanel` integration out of spaday core. Its
self-contained `<perspective-panel>` bundle includes Perspective's client, viewer, workspace, datagrid,
themes, and viewer WASM.

```python
from spaday.backends.starlette import serve
from spaday_perspective import PerspectivePanel

page = PerspectivePanel(
    config={
        "ws_url": "/perspective",
        "tables": ["orders"],
        "layout": {"viewers": {}},
    },
    theme="dark",
)

app = serve(page, packages=["perspective"])
```

This keeps Perspective's bulk data on its native websocket. A spaday/transports model only needs to
carry the small serializable connection/layout config. Replacing `config` reconnects when `ws_url`
changes and restores changed layouts; `theme` accepts `light`, `dark`, or a Perspective theme name.

Installing this project registers the `perspective` entry point with spaday. The equivalent explicit
forms are `packages=[spaday_perspective.package]` and `packages=["spaday_perspective:package"]`.

> [!NOTE]
> This library was generated using [copier](https://copier.readthedocs.io/en/stable/) from the [Base Python Project Template repository](https://github.com/python-project-templates/base).
