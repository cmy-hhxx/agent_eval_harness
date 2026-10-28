呈现一场对战图，适合需要并排解释双方回答的请求。先用 read_case 或已有材料了解本题，再填写解释；模型名称和胜负取自正式结果，无需填写。

reference 沿用真实对战引用或原问关键词定位，candidates[].model 使用本场模型标识。title 概括原问题，summary 概括实际回答；每方用1–3条 paths 说明具体依据 evidence 和用户影响 impact。assessment 为 strength（优点）、problem（已确认问题）或 uncertain（待核验），reason 概括判断依据。
counterEvidence 按需填写已知的重要反证或边界，没有可省略；caveat 只补充影响理解的局限。措辞由你判断，不因正式胜负改变问题的确定性。

高亮可省略。需要时复制对应字段中的唯一短语；最多两处、每处16字；omittedHighlights 表示对应装饰未显示，不影响图中数据。
图已完整回答请求时设 complete:true，成功后结束；仍有其他内容要回答时省略或设 false。成功图自动显示在回答中，不再逐段复述。
