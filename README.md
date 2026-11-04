<div align="center">

# gbrain-cockpit

**The missing adjudication & graph UI for self-hosted [gbrain](https://github.com/garrytan/gbrain)**

**English** · [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: Design Phase](https://img.shields.io/badge/status-design_phase-orange)
[![GitHub stars](https://img.shields.io/github/stars/GeforceLee/gbrain-cockpit?style=flat)](https://github.com/GeforceLee/gbrain-cockpit/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/GeforceLee/gbrain-cockpit?include_prereleases&style=flat)](https://github.com/GeforceLee/gbrain-cockpit/releases)

</div>

gbrain-cockpit is a web UI for self-hosted gbrain (`gbrain serve`): an **adjudication inbox** that clears out everything the nightly `dream` maintenance cycle produces, a **nebula graph** for roaming your entire knowledge base, plus page browsing, search, and a service health panel.

```
dream proposes overnight → you adjudicate in the inbox each morning → the graph is always roamable
```

## Why

The official and community interfaces each cover a slice of the problem — nobody covers content adjudication:

| | Official `/admin` | gbrain.io | Community Stargraph | **gbrain-cockpit** |
|---|---|---|---|---|
| Ops monitoring (requests / jobs / credentials) | ✅ | ✅ | — | Linked out, no duplication |
| Memory content browsing / editing | — | ✅ (hosted brains only) | Partial | ✅ |
| Knowledge graph visualization | — | — | ✅ | ✅ |
| **dream output adjudication** (takes / trust / edges / facts) | — | — | — | ✅ **the core gap** |

## Status

**Design phase — docs first, no code yet.** The feature and architecture docs are being finalized and will be published here in English and Chinese once stable; development starts after the design freezes.

Planned panels: **Inbox** (adjudication) · **Nebula** (graph) · **Pages** · **Search** · **Health**.

## Not affiliated

gbrain-cockpit is a community project with no affiliation to gbrain (garrytan/gbrain). gbrain is Garry Tan's open-source project (MIT); this project only consumes it read-only and invokes its official commands — it never modifies gbrain's data conventions.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=GeforceLee/gbrain-cockpit&type=Date)](https://star-history.com/#GeforceLee/gbrain-cockpit&Date)

## License

[MIT](LICENSE)
