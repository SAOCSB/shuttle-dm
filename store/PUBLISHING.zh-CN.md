# 上架指南（Chrome 应用商店 / Edge 加载项）

本目录已准备好上架需要的全部文字和图片。按下面的步骤操作即可。

## 0. 打包

```bash
bash scripts/build-zip.sh        # 生成 dist/shuttle-dm-<版本>.zip（manifest.json 在压缩包根目录）
```

GitHub Releases 里也附有同样的压缩包，可以直接下载使用。以后发布更新时，先把 `extension/manifest.json` 里的 `version` 改大（例如 `1.0.1`），再重新打包上传。

## 1. Chrome 应用商店

### 1.1 注册开发者账号（只需一次）

1. 打开 <https://chrome.google.com/webstore/devconsole>，用你的 Google 账号登录。
2. 同意开发者协议，支付一次性注册费（5 美元）。
3. 在“账号”页填写并验证联系邮箱；如果后台询问是否为“交易者”（欧盟《数字服务法》要求），个人免费发布的开源项目一般选择“非交易者”。

### 1.2 上传扩展

在开发者后台点击“新增内容”（New item），上传 `dist/shuttle-dm-1.0.0.zip`。

### 1.3 “商品详情”（Store listing）

| 字段 | 填写内容 |
| --- | --- |
| 说明（Description） | 复制 [`listing/en.md`](listing/en.md) 中两条分隔线之间的文字 |
| 类别（Category） | Tools（工具，属于 Productivity） |
| 语言（Language） | English（来自扩展包的默认语言） |
| 商店图标 | [`images/icon-128.png`](images/icon-128.png) |
| 屏幕截图 | [`images/screenshots/en/`](images/screenshots/en) 中的 5 张图，按文件名顺序上传 |
| 小型宣传图块（必填） | [`images/promo/small-440x280-en.png`](images/promo/small-440x280-en.png) |
| 顶部宣传图块（可选） | [`images/promo/marquee-1400x560-en.png`](images/promo/marquee-1400x560-en.png) |
| 首页网址（Homepage URL） | `https://github.com/SAOCSB/shuttle-dm` |
| 支持网址（Support URL） | `https://github.com/SAOCSB/shuttle-dm/issues` |
| 成人内容 | 否 |

扩展包里已经带有 5 种语言的名称和简介（`extension/_locales`），商店会自动显示对应语言的名称和简介。在“商品详情”页顶部的语言下拉框中切换到简体中文、法语、日语、韩语，分别粘贴 `listing/zh-CN.md`、`fr.md`、`ja.md`、`ko.md` 里的说明；如果该语言允许单独上传图片，就上传 `images/screenshots/<语言>/` 和 `images/promo/*-<语言>.png`，否则这些语言会沿用英文图片。

### 1.4 “隐私权规范”（Privacy practices）

按 [`privacy-practices.md`](privacy-practices.md) 逐项填写：单一用途说明、每个权限的理由、“未使用远程代码”、数据使用情况的勾选和三项声明，以及隐私政策网址：

```
https://github.com/SAOCSB/shuttle-dm/blob/main/PRIVACY.md
```

### 1.5 “分发”（Distribution）

免费；公开（Public）；地区选择“所有地区”。

### 1.6 提交审核

点击“提交以供审核”。审核通常需要几天；涉及视频下载的扩展可能会被要求补充说明，可以引用以下几点：

- 扩展只下载用户主动选择的内容，不支持 YouTube，也不会绕过 DRM；
- 所有数据只在本机处理，没有远程代码；
- 源代码公开在 GitHub。

## 2. Microsoft Edge 加载项

### 2.1 注册（免费）

打开 <https://partner.microsoft.com/dashboard/microsoftedge/overview>，用 Microsoft 账号（或 GitHub 账号）登录，按提示注册 Microsoft Edge 计划的开发者账号，账号类型选“个人”。

### 2.2 创建扩展

点击“创建新扩展”（Create new extension），上传同一个 `dist/shuttle-dm-1.0.0.zip`，然后依次填写：

| 页面 | 填写内容 |
| --- | --- |
| 可用性（Availability） | 公开（Public）；市场全选 |
| 属性（Properties） | 类别：Productivity；隐私政策网址同上；网站：`https://github.com/SAOCSB/shuttle-dm`；支持联系方式：`https://github.com/SAOCSB/shuttle-dm/issues`；成人内容：否 |
| 商店列表（Store listings） | 每种语言：说明复制 `listing/<语言>.md`（Edge 要求至少 250 个字符）；徽标 [`images/edge-logo-300.png`](images/edge-logo-300.png)；小型宣传图块 440×280 和大型宣传图块 1400×560（可选）用 `images/promo/` 中对应语言的图片；屏幕截图用 `images/screenshots/<语言>/`（1280×800，最多 6 张） |

### 2.3 提交

在“认证说明”（Notes for certification）中粘贴 [`edge-certification-notes.md`](edge-certification-notes.md) 里代码块中的文字，然后点击“发布”（Publish）。认证最多需要 7 个工作日。

## 3. 上架之后

商店审核通过后，把商店链接加到 `README.md` 和 `README.zh-CN.md` 的“安装”部分。
