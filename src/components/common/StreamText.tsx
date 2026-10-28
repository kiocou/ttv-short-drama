import React, { useMemo } from 'react';

/**
 * 流式打字：文本逐字从 `blur(6px)` 晕开到清晰。
 *
 * ## 这个组件解决什么问题
 *
 * 一段文本「一次性出现」时，读者的眼睛会被整块文字同时拽住，没有引导、也没有
 * 轻重。逐字晕开把这一块拆成一条时间线：最先出现的字先被读到，后面的字还在
 * 虚焦里等着——于是阅读节奏由内容自己给出，而不是由读者的意志硬推。
 *
 * 这不是"炫技型"动效。它只在**值得被读**的文本上成立：更新说明、公告、
 * 首屏介绍。用在高频交互上（toast、按钮文案、列表项）会变成噪音——因为那些
 * 文字本来就是扫一眼就走的，逐字只会拖慢它。
 *
 * ## 参数（与设计规格一致）
 *
 * - 单字时长 `90ms`
 * - 相邻字错开 `30ms`（`--stagger`）
 * - 缓动 `cubic-bezier(.215, .61, .355, 1)`（`--ease-out-quint`）
 * - 起点 `blur(6px)` + `opacity: 0`，终点 `blur(0)` + `opacity: 1`
 *
 * 为什么单字 90ms 而错峰 30ms：单字必须**快**（90ms 内完成，读者感知不到"一个
 * 字在动"），错峰决定**整段的节奏**（30ms × 字数 = 总时长）。如果两者相等，
 * 文本会像走马灯一样一个字一个字跳；错峰远小于单字时长，相邻字才会"叠着晕开"，
 * 形成一条连续的波前而不是一串离散的闪光。
 *
 * ## 三个必须处理的无障碍细节
 *
 * 1. **逐字 span 全部 `aria-hidden`**：否则屏幕阅读器会把每个字当成独立文本
 *    节点读，变成"更、新、说、明"这样一个字一个字往外蹦；
 * 2. **容器挂 `aria-label` 保留完整文本**：屏幕阅读器读这一条，一次读全；
 * 3. **`prefers-reduced-motion` 下整段直出**：不做逐字，直接显示（见 CSS）。
 *    模糊动画对前庭敏感用户不友好，而"逐字出现"本身也会造成阅读节奏的
 *    不可控。
 *
 * ## 为什么不用 CSS `animation-delay` 逐字
 *
 * 也可以，但需要给每个字内联一个 `style={{ animationDelay }}`——字数是动态的，
 * 内联样式会产生 N 个不同的 style 对象，React 每次渲染都要 diff 全部。这里用
 * CSS 自定义属性 `--i` 传递序号，同样能做到，但**整段只有一个 style 对象**
 * （在容器上给 `--stagger`），逐字节点只带一个 `--i` 数字。列表里成百个节点时
 * 这个差别很明显。
 */
export interface StreamTextProps {
  /** 要逐字展示的文本。含换行符时按段落拆开（每个段落独立错峰）。 */
  text: string;
  /** 相邻字错开时长（毫秒）。默认 30ms，与设计规格一致。 */
  stagger?: number;
  /** 整体延迟（毫秒）。用于让它在容器入场之后再开始。默认 0。 */
  delay?: number;
  className?: string;
}

export const StreamText: React.FC<StreamTextProps> = ({
  text,
  stagger = 30,
  delay = 0,
  className = '',
}) => {
  /**
   * 按「段落」分组，段内逐字，段间继续累计序号。
   *
   * 为什么保留换行：更新说明是多段文本（`whitespace-pre-wrap` 在旧实现里就是
   * 为了这个）。如果整段当一个长串拆字，换行符会变成一个不可见的字符占一个
   * 错峰位，段落之间就多出一段空白等待——读起来像卡住了。
   */
  const paragraphs = useMemo(() => {
    const lines = text.split('\n');
    let cursor = 0;
    return lines.map(line => {
      const start = cursor;
      cursor += line.length;
      return { line, start };
    });
  }, [text]);

  return (
    <span
      className={`ttv-stream ${className}`}
      // 完整文本给屏幕阅读器；逐字 span 全部 aria-hidden。
      aria-label={text}
      // 整段共用一个 stagger，逐字只带序号，见组件注释最后一段。
      style={{ ['--stagger' as string]: `${stagger}ms`, ['--stream-delay' as string]: `${delay}ms` }}
    >
      {paragraphs.map((para, pIndex) => (
        <React.Fragment key={pIndex}>
          {pIndex > 0 && <br />}
          <span aria-hidden="true">
            {Array.from(para.line).map((char, i) => (
              <span
                key={i}
                className="ttv-stream-char"
                style={{ ['--i' as string]: para.start + i }}
              >
                {char === ' ' ? '\u00A0' : char}
              </span>
            ))}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
};

export default StreamText;
