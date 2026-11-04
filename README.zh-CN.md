<div align="center">

# gbrain-cockpit

**给自托管 [gbrain](https://github.com/garrytan/gbrain) 补上缺失的裁决与图谱界面**

[English](README.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: Design Phase](https://img.shields.io/badge/status-design_phase-orange)
[![GitHub stars](https://img.shields.io/github/stars/GeforceLee/gbrain-cockpit?style=flat)](https://github.com/GeforceLee/gbrain-cockpit/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/GeforceLee/gbrain-cockpit?include_prereleases&style=flat)](https://github.com/GeforceLee/gbrain-cockpit/releases)

</div>

gbrain-cockpit 是给自托管 gbrain（`gbrain serve`）的 Web 界面：一个把每晚「dream」维护产物清掉的**裁决收件箱**，一张可以漫游整个知识库的**星云图**，外加页面浏览、搜索与服务健康面板。

```
dream 整夜提案 → 你早晨在收件箱里一键裁决 → 知识图谱实时可漫游
```

## 为什么需要它

gbrain 官方与社区现有界面各管一段，唯独没人管「内容裁决」：

| | 官方 `/admin` | gbrain.io | 社区 Stargraph | **gbrain-cockpit** |
|---|---|---|---|---|
| 运维监控（请求/作业/凭据） | ✅ | ✅ | — | 外链过去，不重复 |
| 记忆内容浏览/编辑 | — | ✅（仅托管大脑） | 部分 | ✅ |
| 知识图谱可视化 | — | — | ✅ | ✅ |
| **dream 产物裁决**（takes/信任/关系/事实） | — | — | — | ✅ **核心空位** |

## 项目状态

**设计阶段，文档先行，代码尚未开始编写。** 功能与架构设计文档正在定稿，稳定后将以中英双语发布到本仓库；设计冻结后进入开发。

规划中的五面板：**Inbox**（裁决收件箱）· **Nebula**（星云图）· **Pages**（页面）· **Search**（搜索）· **Health**（健康）。

## 非官方声明

本项目是社区项目，与 gbrain 官方（garrytan/gbrain）无隶属关系。gbrain 是 Garry Tan 的开源项目（MIT）；本项目对其只做**只读消费与官方命令调用**，不修改 gbrain 任何数据约定。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=GeforceLee/gbrain-cockpit&type=Date)](https://star-history.com/#GeforceLee/gbrain-cockpit&Date)

## License

[MIT](LICENSE)
