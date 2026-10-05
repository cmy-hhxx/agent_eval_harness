读取先前工具返回的产物，id 使用该产物的原编号；图片返回图片内容，文本返回当前页及分页字段。文本 has_more=true 时，保持 id 不变，将 next_offset 原样作为下次 offset，直到 has_more=false。产物用于辅助核查；引用原材料仍使用 read_trace/search_trace 返回的 reference。
