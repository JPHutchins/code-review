<!-- code-review -->
<!-- reviewed-sha: 0000000000000000000000000000000000000000 -->

### 🔍 Code review — 💬 comment

**Route:** full review (all green) · **effort:** max

Adds a retry wrapper around the upload client and threads a timeout through the config. The change is
focused and the happy path is solid; two correctness issues below, plus a couple of nits.

---

#### 🔴 critical · `src/upload/client.py:142`

Retvalue of `flush()` is ignored, so a partial write is reported as success. Under a short timeout the
caller will believe all bytes landed.

```suggestion
        wrote = await self._flush()
        if wrote != len(chunk):
            raise PartialWriteError(wrote, len(chunk))
```

#### 🟠 major · `src/upload/config.py:31-34`

`timeout` is read as a string from the env and compared to an int, so the guard never trips. Coerce at
the edge.

<details>
<summary>🔵 2 minor / nit findings</summary>

#### 🔵 minor · `src/upload/client.py:88`
Docstring says "retries 3×" but the constant is `MAX_RETRIES = 5`. Types are the SSOT — drop the count
from the prose.

#### ⚪ nit · `src/upload/__init__.py:1`
Unused re-export of `LegacyClient`.

</details>

---

<details>
<summary>✅ Test results — 128 passed, 0 failed (from CTRF)</summary>

| | count |
|---|---:|
| passed | 128 |
| failed | 0 |
| skipped | 3 |

Slowest: `test_upload_large_file` (4.1s), `test_retry_backoff` (2.7s).

</details>

---

<sub>

| Model | Input | Output | Cache read | Cost |
|---|--:|--:|--:|--:|
| deepseek-v4-pro | 84,201 | 6,540 | 61,020 | $0.038 |
| deepseek-v4-flash | 12,880 | 1,110 | 0 | $0.002 |
| **Total** | **97,081** | **7,650** | **61,020** | **$0.040** |

turns: 9 · wall: 87s

</sub>

> [!NOTE]
> **LLM Disclosure** — this review was produced by `deepseek-v4-pro` (subagents: `deepseek-v4-flash`)
> running headless in an ephemeral, egress-locked CI runner with no write access to the repository.
> It is advisory and does not block merge.
