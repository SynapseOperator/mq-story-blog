# 羽毛信独立装饰素材

本目录服务于 Issue #4 的交互原型。素材通过内置 `image_gen` 工具生成，参考已确认 B 的暖米黄色、自然旧纸、磨损边缘和克制羽毛方向；不是 B 的逐像素切片，也没有复制其中的文字或 UI。最终视觉仍待产品负责人和独立开发者评审。

| 文件 | 像素 / 编码 | 用途 |
|---|---|---|
| `aged-paper-v2.webp` | 1024×1536，带 alpha 的无损 WebP，1,583,956 字节 | 无字纸张；CSS 九片边缘保持窄磨损边，同一有界装饰层承载整个阅读流 |
| `quill.webp` | 1024×1536，带 alpha 的无损 WebP，801,682 字节 | 独立羽毛装饰，不拦截交互；小屏缩小并放到文字安全区外 |

两项合计约 2.39 MB，随阅读层出现加载；首页静态场景素材未替换。原 PNG 保留在本机图像生成目录，不重复提交。仅使用 Sharp 做无损格式转换，没有插值增大分辨率、程序抠图或人为重绘。纸张最初大折角侵入文字安全区，因此通过第二次内置图像编辑去除；最终版没有跨正文折痕。CSS 依视口调整纸面外框，文章长度只改变内容滚动高度，不改变纸张尺寸。

文章配图复用 `/scene/night-sky.webp`，在 UI 的 alt/图注中明确标为合成演示，不是真实旅行照片。点赞、留言及正文均为可访问的 DOM，不在素材中烘焙。

与 B 的差异：纸张纤维、破边和羽毛为新制变体；没有复制邮戳/蝴蝶印章、概念图文字、照片和数字；中文字体采用本机宋体/楷体回退。移动端目录、纸张尺寸、字体及动画节奏仍待评审。参考图片的背景/UI 痕迹不覆盖 PRD：读信继续使用 A 的已实现 MQ 场景并隐藏导航和普通账号入口。

## 实际生成提示词

### 纸张初稿

```text
Create a production-ready web decorative asset: one blank nineteenth-century European romantic letter paper, straight-on flat orthographic, portrait 2:3 proportions, filling almost all of the canvas with a narrow transparent margin. Warm pale creamy beige center (#f5e1b9), finely detailed natural handmade paper fibers and very delicate mottling; richly convincing frayed irregular deckle edges, worn brown edges and gently lifted/torn upper-left corner. Keep the center 80% very quiet and legible for Chinese text that will be rendered separately. Aged elegant love letter, not a treasure map, not burnt black. Absolutely NO text, NO handwriting, NO symbols, NO stamps, NO feathers, NO photographs, NO buttons, NO folds across the paper, NO scroll rods, NO background scene. True transparent alpha around the entire paper. Very high quality tactile realistic illustration, softly lit. The only object is the sheet of blank paper.
```

### 纸张定向修正

```text
Edit only the upper-left corner of this blank letter-paper asset. Remove the large triangular folded / peeled-back corner completely. Continue the same quiet pale beige paper surface right up into that upper-left area, with only a narrow irregular worn deckle edge consistent with the other three sides. Preserve the exact warm colors, subtle fine fiber texture, portrait proportions, natural narrow worn brown perimeter and transparent alpha background. No new elements, no text, no stamps, no feather. The paper must have no large folds anywhere; its central writing area including the top left must remain flat and legible.
```

### 独立羽毛

```text
A single delicate antique writing feather, an isolated quill web decoration. The feather is slender with beautifully detailed warm ivory and muted honey-brown barbs, gently curved shaft pointing down-left and feather tip toward upper-right, around 25 degrees from vertical. Straight-on realistic tactile illustration, soft warm light, nineteenth-century romantic letter aesthetic. Feather only, NOT an inkwell, no paper, no text, no other objects, no frame, no cast-shadow rectangle. Fully transparent alpha background around the feather, clean natural fine edges. Vertical asset, fit the entire feather with very small transparent padding, restrained sepia colors.
```
