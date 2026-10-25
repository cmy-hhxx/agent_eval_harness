### 本次有标准数值点

numeric_references是标准数值目录。numeric_checks仅选择原题所求的同口径直接点值；日期、代码、区间及需解释的表达在正确性理由处理，混合情形保留其余点值。reference_index沿用目录，actual保留回答原值，缺项为null，大整数用十进制字符串；evidence_index选本方最终回答。

scale填写有依据的单位倍率字符串，同单位为"1"，万/亿按实际表达单位转换。rounded把actual×scale按标准末位舍入，exact精确比较，离散计数用exact；不二次舍入、倒推原值或擅放容差。matches只记录算术观察；实体、期间或题设容差影响语义判断时，在correctness_reason说明，不能修改原值制造匹配。
