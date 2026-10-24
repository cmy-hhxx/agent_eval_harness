const reasons={
  request_time_missing:'缺请求时间',request_time_invalid:'请求时间格式无效',timestamp_time_invalid:'请求时间戳无效',request_date_conflict:'请求日期冲突',
  answer_empty:'空回答',invalid_json:'JSON 格式错误',invalid_json_number_or_depth:'JSON 数值或嵌套无效',record_not_object:'记录格式无效',record_or_meta_invalid:'记录或元数据无效',meta_invalid:'元数据格式无效',
  duplicate_case:'重复记录',duplicate_trace:'重复 Trace',identity_conflict:'业务身份内容冲突',trace_identity_conflict:'Trace 身份内容冲突',local_import_overlap:'与已登记输入重叠',
  question_missing:'缺问题',question_invalid:'问题无效',model_unknown:'无法识别模型',version_mismatch:'回答模式不匹配',batch_id_invalid:'批次身份无效',
  trace_id_missing:'缺少 Trace',missing_trace_id:'缺少 Trace',traces_invalid:'Trace 列表无效',trace_invalid:'Trace 格式无效',trace_meta_invalid:'Trace 元数据无效',
  single_trace_required:'单轮 Trace 数量无效',multiple_traces_not_supported:'多轮待支持',session_traces_invalid:'会话 Trace 列表无效',session_trace_invalid:'会话 Trace 格式无效',empty_session:'空会话',collection_failed:'采集失败',
  case_id_conflict:'问题身份冲突',case_id_missing:'缺问题身份',identity_missing:'缺业务身份',business_identity_missing:'缺业务身份',session_identity_missing:'缺会话身份',
  aime_mode_unknown:'AIME 模式无法识别',aime_mode_conflict:'AIME 模式冲突',ifind_mode_unknown_or_conflicting:'iFind 模式无法识别或冲突',
  message_chain_invalid:'消息链格式无效',messages_invalid:'消息列表格式无效',message_type_unsupported:'消息类型待支持',evaluator_input_invalid:'评测输入无效',
  standard_answer_flag_invalid:'标准答案标记无效',standard_answer_conflict:'标准答案冲突',testset_date_ambiguous:'数据日期不明确',testset_date_invalid:'数据日期无效',file_read_failed:'文件读取失败',
};
export const cleaningReason=value=>reasons[value]||value||'未知原因';
