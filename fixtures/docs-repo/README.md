---
title: Ignored front matter title
---

# Architecture Docs

## Overview

Read the [guide](guides/guide.md#install), the [Python service](src/service.py), and
the [same guide][guide-ref]. See the [guide](guides/guide.md#install) again.

![Architecture image](assets/architecture.svg)

[Broken target](missing.md), [wrong case](Guides/guide.md),
[Windows path](guides\guide.md), and [mail](mailto:docs@example.com).

[External docs](https://example.com/docs) and <https://autolink.example/docs>.

[Malformed link](malformed.md
<a href="html-only.md">HTML is not parsed as Markdown</a>
<script src="script.js"></script>
\[Escaped link](escaped.md)
\<https://escaped.example/docs>

`[inline code](hidden-inline.md)`

``
[multiline code span](hidden-multiline.md)
``

```markdown
[fenced code](hidden-fence.md)
# Hidden heading
```

[guide-ref]: guides/guide.md "Guide"
