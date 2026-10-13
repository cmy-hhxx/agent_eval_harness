呈现单例对战图，成功后自动显示在回答开头。reference 使用已读案例的引用，model 使用 answers[].model；组名与胜负绑定正式结果。

title 概括原问题，summary 概括双方实际回答；paths 展示关键依据、判断及其对用户的影响，reason 归纳本次结论。assessment 为 strength（优点）、problem（已确认问题）或 uncertain（事实待核验）。
counterEvidence 填已知的相关反证或判断边界，没有则省略或填 null；已知重要反证仍须写出。常规解读依据已有评测与回答即可，不为填写此字段另开调查。caveat 按需补充影响理解的局限。简洁表达即可，不为凑短句删掉事实或限定条件。
高亮直接复制对应字段中的唯一连续短语。程序最多保留两处、每项一处、每处16字，优先 reasonHighlight，再按路径顺序；无效或多余高亮自动省略，原文与判定不变，回执 omittedHighlights 记录位置，无需为此重提图稿。

图完整回答请求时设 complete:true，成功即结束；还有内容要补充时设 complete:false，继续用正文完成回答，省略也会继续。收到 comparison-check 的 issues 表示草稿尚未展示，按具体问题修正后重新提交；仅在材料确有缺口时补读。
