# Issue #2 场景素材

> 2026-10-21 产品评审：本目录初版素材对应的页面**视觉未通过**，不能作为正式 A 的替代。返工依据为 [已确认视觉交接](../../docs/product/visual-baseline-v1.0/VISUAL_HANDOFF.md)，缺口见 [素材需求](../../docs/engineering/ISSUE_2_REVIEW.md#素材缺口与交付要求)。现有文件保留以供复现；待用户提供分层素材或确认制作方式后再替换。

这些素材于 2026-10-21 使用本会话内置 ImageGen 单独生成，用于 MQ 静态原型；没有使用真实人物照片、原始手绘或课程材料。不是从概念图裁切，也没有将整幅概念图作为页面背景。AI 生成素材不冒称第三方开源素材；使用本套素材的初版已被产品负责人判定为视觉不通过，目前仅保留供复现，返工后再由两位开发者共同评审。

| 文件 | 尺寸 | 用途 | 透明通道 |
| --- | --- | --- | --- |
| `night-sky.webp` | 1536 × 1024 | 深蓝夜空、银河及静态星尘 | 无 |
| `grassy-hillside.webp` | 1536 × 1024 | 远山和茂盛青草坡 | 有，天空区域透明 |
| `couple.webp` | 900 × 900 | 背面并肩而坐的虚构成年情侣 | 有 |
| `campfire.webp` | 600 × 600 | 独立篝火与木柴 | 有 |

生成方向：写实绘本质感、午夜蓝与灰绿、右侧暖金篝火光；天空不包含地面，地面不包含人物或火，人物和篝火均为独立透明素材。草坡保留少量自然野花；无萤火虫、可交互热点、文字或 UI。

各次提示词核心约束：

- 天空：wide midnight navy sky, subtle Milky Way, tiny stars; no horizon, ground, people, fire, moon, text or UI; calm upper center for separate wordmark。
- 草坡：wide lush grassy hillside and low distant mountain ridges, transparent above skyline, blue moonlight, subtle reflected amber light; no sky, people, fire or buildings。
- 情侣：rear view, seated shoulder to shoulder, ivory knitwear and cream dress, natural adult anatomy, cool light from left and warm light from right; transparent background, no identifiable real people。
- 篝火：small cozy campfire, rough split logs and natural amber flames, translucent edges; transparent background, no surrounding landscape or floating sparks。

原始生成 PNG 保留在本机 Codex 素材缓存。仓库版本仅用 Sharp 做等比缩小与 WebP 编码（quality 90、alphaQuality 100），未做背景抠图或内容重绘。四张合计 1,012,456 bytes；所有路径本地提供，无外部素材网络请求。

页面结构：天空 → 气氛渐层 → 远山/草坡 → 地面火光 → 情侣 → 篝火 → 边缘暗角；Logo、导航、账号占位与原型说明属于独立 UI。CSS 可单独定位各层，当前没有循环动画、视差或星火点击事件。远山与草坡目前共用一张环境素材；需要独立远景视差时可在后续获批任务中进一步拆分。
