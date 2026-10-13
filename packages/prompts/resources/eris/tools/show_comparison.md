呈现单例对战图，成功后自动显示在回答开头。reference 使用已读案例的引用，model 使用 answers[].model；组名与胜负绑定正式结果。

title 概括原问题，summary 概括双方实际回答；paths 展示关键依据、判断及其对用户的影响，reason 归纳本次结论。assessment 为 strength（优点）、problem（已确认问题）或 uncertain（事实待核验）。
counterEvidence 填已知的相关反证或判断边界，没有则填 null；常规解读依据已有评测与回答即可，不为填写此字段另开调查。caveat 按需补充影响理解的局限。字段长度与数量以参数约束为准。

图完整回答请求时设 complete:true，成功即结束；还有内容要补充时设 complete:false，继续用正文完成回答。收到 comparison-check 的 issues 表示草稿尚未展示，按具体问题修正后重新提交；仅在材料确有缺口时补读。
