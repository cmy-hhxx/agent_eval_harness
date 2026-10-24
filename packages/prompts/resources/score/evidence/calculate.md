Score取证时，inputs.*.evidence_id填写原始source_id（Q、A、C001、V_SRC_等），绝不是review_material.quote返回的EV_编号。quote填写该原始来源中唯一连续原文，number_token原样摘自quote，expression只用inputs变量名。
示例：来源Q为“收入从100增加至120。”时，inputs为{start:{evidence_id:"Q",quote:"收入从100增加至120。",number_token:"100",role:"起始收入",unit:"元"},finish:{evidence_id:"Q",quote:"收入从100增加至120。",number_token:"120",role:"期末收入",unit:"元"}}，operation为arithmetic，expression为"(finish-start)/start*100"，result_unit为"%"。
成功返回的V_CALC编号也是新增source_id；用review_material.quote引用其实际content，取得EV_证据编号后写入checks.evidence_ids。失败先修正参数，不能用心算冒充已登记的复算。
