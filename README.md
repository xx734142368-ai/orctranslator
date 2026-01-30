# Manga Translator Chrome Extension

## 简介 (Introduction)
这是一个 Chrome 浏览器扩展，可以帮助你在线阅读漫画时，实时翻译图片中的外语文本。

## 功能 (Features)
- **截图 OCR**: 选取屏幕区域，自动识别文字 (支持英文、日文等，默认英文/自动)。
- **自动翻译**:集成了免费的翻译 API，将识别到的文字翻译为中文。
- **离线 OCR**: 使用 Tesseract.js，核心识别库运行在本地。

## 安装步骤 (Installation)
1. 打开 Chrome 浏览器，在地址栏输入 `chrome://extensions` 并回车。
2. 打开右上角的 **开发者模式 (Developer mode)** 开关。
3. 点击左上角的 **加载已解压的扩展程序 (Load unpacked)**。
4. 选择本项目所在的文件夹: `D:\repo\tupiantranslator`。
5. 安装完成后，浏览器右上角会出现插件图标。

## 使用方法 (Usage)
1. 打开任何包含漫画或图片的网页。
2. 点击浏览器右上角的 **Manga Translator 插件图标**。
3. 在弹出窗口中，确认目标语言（默认为简体中文），点击 **Select Area to Translate**。
4. 鼠标指针会变成十字形，**按住鼠标左键并拖动**，框选你想翻译的气泡或文字区域。
5. 松开鼠标，稍等片刻（取决于电脑性能，OCR 需要几秒钟）。
6. 指定区域旁边会显示识别到的原文和翻译结果。

## 效果与限制 (Performance & Limitations)
- **OCR 准确度**: 
    - 对于清晰、横排的印刷字体效果较好。
    - 对于手写体、竖排文本（日漫常见）或背景复杂的文字，Tesseract.js 的识别率可能较低。
- **翻译质量**: 
    - 目前使用的是免费翻译接口，对于简单的句子准确度尚可。
    - 复杂的俚语或长句可能不够通顺。
- **速度**: 
    - 第一次运行时需要加载 OCR 模型，可能需要几秒钟。后续会更快。

## 开发说明 (Development)
- 核心代码位于 `content/content.js`。
- OCR 使用 Tesseract.js v5。
