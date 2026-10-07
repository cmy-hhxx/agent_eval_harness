// Editorial summaries for cases 16–30. Each row retains one original comparison index.
// Accepted findings, uncertainty and candidate-specific scope are preserved, not re-evaluated.
window.ReportCaseSummariesB = {
  "cmp_c67a18c8-118f-4e68-bb3f-1969d451b39c": {
    checks: ["7只同时满足三条件，与标准一致", "7只同时满足三条件，与标准一致"],
    rows: [
      {label:"筛选结果",values:["7只与标准一致；引用查询结果，图片承载名单", "7只与标准一致；附具体涨跌幅与可追溯引用"],comparisonIndices:[0]},
      {label:"开头风险",values:["本方专属要求未满足：开头无明确风险提示", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[1]},
      {label:"耗时与用量",values:["10.546秒；20888 token，含缓存17600", "6.157秒；16836 token；资源差异不改变结果"],comparisonIndices:[2]}
    ]
  },
  "cmp_bef48fca-fa22-4b72-a8f8-ec30517c6854": {
    checks: ["归因确认7只与标准一致；对局仍待复核", "归因确认完整7只满足条件；对局仍待复核"],
    rows: []
  },
  "cmp_ed9bb2e9-d7a3-4870-b6a8-6a667e399ef1": {
    checks: ["声称6只却未交付对应名单，图片仅为单项筛选", "腾景科技及四项数据与标准、工具均一致"],
    rows: [
      {label:"筛选名单",values:["称6只却无对应名单；图片为32项单条件结果的前5项", "唯一标的腾景科技符合标准；60.95元等四项数据吻合"],comparisonIndices:[0]},
      {label:"开头风险",values:["本方专属要求未满足：选股回答开头未提示风险", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[1]},
      {label:"耗时与用量",values:["12.095秒；20495 token，含缓存17600", "6.938秒；16469 token"],comparisonIndices:[2]}
    ]
  },
  "cmp_04c5d634-861c-43ed-927d-d00df541c96c": {
    checks: ["列5只含腾景科技；区间口径与单只标准冲突，待核", "列4只含腾景科技；工具与单只标准冲突，待核"],
    rows: []
  },
  "cmp_4ea7490a-0092-43b3-9931-8dd87b71eacb": {
    checks: ["公司数据与介绍齐备；市值图渲染仍不确定", "港股归属及代码有误，缺少具体财务数据"],
    rows: [
      {label:"标的识别",values:["列10家A股，扩展至散热与结构件材料；未列港股", "列7家A股及3个港股项；立讯代码错误，华通实为台股"],comparisonIndices:[0]},
      {label:"公司数据",values:["逐家给出营收、净利及增速等具体业绩数据", "仅有市值区间和定性描述，缺少具体财务数据"],comparisonIndices:[1]},
      {label:"主攻方向",values:["逐家列导热材料、石墨膜、铜合金、玻璃等具体产品", "表格覆盖FPC、HDI、覆铜板及结构件两大领域"],comparisonIndices:[2]},
      {label:"当前市值",values:["工具有10家市值；正文未列数字，图表chart字段为空", "7家A股直接列约数区间，明确市值口径有限"],comparisonIndices:[3]},
      {label:"公司介绍",values:["10家均详述主营、客户逻辑、业绩与风险", "仅4家详述；其余公司只有表格行或简短说明"],comparisonIndices:[4]},
      {label:"开头风险",values:["本方专属要求已满足：开头加粗提示投资风险", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[5]},
      {label:"耗时与用量",values:["reported总量83855 token；耗时缺失", "12.736秒、15687 token；双方计量口径不同，不直比"],comparisonIndices:[6]}
    ]
  },
  "cmp_ce9586fa-864b-4da9-b906-3054d1870b98": {
    checks: ["五项诉求有交付；建滔积层板市值存疑", "数据方向市值齐；公司总数矛盾，详细介绍不足"],
    rows: [
      {label:"标的识别",values:["按六层产业链列公司与兑现评级，未见数量自相矛盾", "表内16家却称12家；中英科技偏通信雷达仍入主表"],comparisonIndices:[0]},
      {label:"公司数据",values:["数值主要是市值；缺营收净利精确值，交互表未落地", "逐家有营收增速、净利增速、PE；港股财务列缺币种"],comparisonIndices:[1]},
      {label:"主攻方向",values:["产品范围细至玻璃布、树脂、铜箔与高速材料等级", "逐家公司给5—20字主营及AI手机关联定位"],comparisonIndices:[2]},
      {label:"当前市值",values:["原判：建滔1647亿港元无依据，误用1647家企业数", "原判认可16家市值；建滔1646.6亿港元按所列口径"],comparisonIndices:[3]},
      {label:"公司介绍",values:["逐家给主攻方向、关联评级、关键特征与纯度排序", "逐家仅一行短描述，板块分析不能替代公司详述"],comparisonIndices:[4]},
      {label:"开头风险",values:["本方专属要求已满足：开头覆盖估值、需求等风险", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[5]},
      {label:"耗时与用量",values:["耗时缺失；总量约131969 token", "约509.9秒、1041406 token；耗时无法双方比较"],comparisonIndices:[6]}
    ]
  },
  "cmp_68bd9350-534b-468d-9c55-7256928f905d": {
    checks: ["覆盖扭亏、转型、注入与资金因素，数据可溯源", "扭亏、装机、机构覆盖三类驱动有来源支持"],
    rows: [
      {label:"异动归因",values:["拆四板块利润，补充注入、概念与资金流；区分事实和预期", "覆盖扭亏、装机与机构覆盖；未纳入注入及资金流等因素"],comparisonIndices:[0]},
      {label:"开头风险",values:["本方专属要求已满足：首段明确提示投资风险", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[1]},
      {label:"耗时与用量",values:["约14.1秒；47865 token，含缓存19328", "约13.7秒；19409 token，单次用量较低"],comparisonIndices:[2]}
    ]
  },
  "cmp_5228248c-2649-4b59-8bac-b1b950f1f0a6": {
    checks: ["业绩、注入、政策、资金与风险分析完成", "分7月与9月归因，量价及公告证据可核对"],
    rows: [
      {label:"异动归因",values:["五维分析含股权收购、容量电价与现金流，关键数字吻合", "区分7月短炒、9月业绩与增资，附龙虎榜和相对走势"],comparisonIndices:[0]},
      {label:"开头风险",values:["本方专属要求未满足：含预测，风险提示却放第5节末", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[1]},
      {label:"耗时与用量",values:["81813 token，含缓存67392；耗时缺失", "635.128秒、1195234 token；含两图及更细量价表"],comparisonIndices:[2]}
    ]
  },
  "cmp_afaee0a3-512d-44ac-b0af-a9c050bb9121": {
    checks: ["多角度解释下跌，关键业绩和商品数据有来源", "宏观、钴业、仲裁、业绩与技术面分析完成"],
    rows: [
      {label:"下跌原因",values:["六维归因，含周期定价与观察信号；引用16个来源", "五维归因，含仲裁与技术资金面；8个来源，未单列定价逻辑"],comparisonIndices:[0]},
      {label:"高点口径",values:["称1月高点28.37元，独立来源口径不一致；不改核心归因", "原槽标为不适用，仅核对回答①"],comparisonIndices:[1]},
      {label:"前置风险",values:["开头加粗风险提示，满足本方专属要求", "该槽不适用；自身开头提示及结尾追问不作对方核查项"],comparisonIndices:[2]}
    ]
  },
  "cmp_4e68fe13-3c0d-49ba-9d54-1996784e2c23": {
    checks: ["铜价、钴销量与资金三主因有数据支撑", "四层归因含反向验证与跟踪信号，核心可用"],
    rows: [
      {label:"下跌原因",values:["三维归因；同业比较与所选区间不符，下跌起点锚定偏弱", "四层归因，以同业与目标价上调反证，附三段下跌路径"],comparisonIndices:[0]},
      {label:"开头风险",values:["本方专属要求已满足：主结论后紧跟风险提示", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[1]},
      {label:"耗时与用量",values:["49.2秒；总量约7.3万 token", "512.56秒；总量约24.3万 token"],comparisonIndices:[2]}
    ]
  },
  "cmp_a73cc21f-49c1-4100-9371-e9c740f61c17": {
    checks: ["明确回答受益并展开分析；缺开头风险不影响核心", "明确回答受益，业绩产品市场风险均有证据"],
    rows: [
      {label:"受益分析",values:["肯定受益；分析产品客户、景气、业绩、定价及7项风险", "肯定受益；覆盖业绩、产品、机构态度与风险四维"],comparisonIndices:[0]},
      {label:"开头风险",values:["本方专属要求未满足：开头先给方向判断，未提示风险", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[1]},
      {label:"耗时与用量",values:["11.934秒；45019 token", "12.474秒；18147 token；耗时接近、用量较少"],comparisonIndices:[2]}
    ]
  },
  "cmp_223c1c9e-93b6-4457-876f-06ad5701c7f9": {
    checks: ["受益结论明确，业绩客户估值与验证信号齐备", "受益判断有财务估值证据；轻微瑕疵不改方向"],
    rows: [
      {label:"受益分析",values:["事实、机构判断与待验证信息分层；未见核心数据瑕疵，附图", "静态PE136倍及利润2.6亿元与来源偏差；不改受益方向"],comparisonIndices:[0]},
      {label:"开头风险",values:["本方专属要求已满足：结论后紧跟波动与估值等风险", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[1]},
      {label:"耗时与用量",values:["约68秒；reported约8.1万 token", "约304秒；输入加输出约22.5万 token"],comparisonIndices:[2]}
    ]
  },
  "cmp_0ec4b2c1-c8f8-4f29-840b-b0973fa816ef": {
    checks: ["两只ETF通过所列技术核验，结果可交付", "两只ETF满足条件，另三只不达标仅列观察"],
    rows: [
      {label:"基金范围",values:["1332只场内ETF作基池；跨境剔除关键词未完整公开", "查询明确剔除四类基金；最终两只均为股票型ETF"],comparisonIndices:[0]},
      {label:"前低抬高",values:["两只分别1.417>1.400、0.340>0.327", "两只分别1.409>1.378、0.338>0.325"],comparisonIndices:[1]},
      {label:"阶段新高",values:["两只均于9月23日创新高：1.487、0.349", "9月23日收盘均创新高；563300另于9月21日创新高"],comparisonIndices:[2]},
      {label:"高后回调",values:["新高后分别回撤3.70%、2.29%", "收盘均低于近期峰值，分别回撤3.83%、2.29%"],comparisonIndices:[3]},
      {label:"不破前低",values:["1.417>1.400、0.340>0.327，均未跌破前低", "1.409>1.378、0.338>0.325，均未跌破前低"],comparisonIndices:[4]},
      {label:"5日高于10日",values:["MA5/MA10约1.006、1.009，均大于1", "列出两只MA5、MA10数值，均满足MA5>MA10"],comparisonIndices:[5]},
      {label:"10日高于20日",values:["仅筛选表达式通过，未展示MA10/MA20数值；证据待核", "列出两组数值：1.4491>1.4435、0.3411>0.3388"],comparisonIndices:[6]},
      {label:"均线乖离",values:["MA5/MA10约1.006、1.009，均小于1.08", "MA5/MA10为1.006、1.008，均小于1.08"],comparisonIndices:[7]},
      {label:"DEA正值",values:["DEA分别0.010、0.001，均大于0", "DEA分别0.010、0.001，均大于0"],comparisonIndices:[8]},
      {label:"当日缩量",values:["亿股：2.527<3.999、9.902<12.462，均低于均量", "亿份：2.53<4.22、9.92<13.57，均低于均量"],comparisonIndices:[9]},
      {label:"成交额",values:["两只约3.61、3.39亿元，均大于3亿元", "两只3.63、3.39亿元，均大于3亿元"],comparisonIndices:[10]},
      {label:"二十日涨幅",values:["未纳入硬筛选式；事后核对−1.45%、0.59%均通过", "筛选式明确纳入；−1.58%、0.59%均小于25%"],comparisonIndices:[11]},
      {label:"开头风险",values:["本方专属要求已满足：开头说明ETF风险及非买入保证", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[12]},
      {label:"口径明示",values:["只说明收盘近似及盘中差异；跨境剔除规则未完整明示", "明示滚动20日收盘新高、前低摆动窗口及缩量口径"],comparisonIndices:[13]},
      {label:"耗时与用量",values:["196.043秒；91818 token，含缓存17792", "429.153秒；388199 token"],comparisonIndices:[14]}
    ]
  },
  "cmp_6ecad7fe-7121-4ebe-977f-b00c7712dc9d": {
    checks: ["仅放宽后参考标的，四项结构条件未核验", "严格口径0只，放宽后1只；阶段新高口径待核"],
    rows: []
  },
  "cmp_4af29c30-932c-45e5-942b-be5c5cdb6a6d": {
    checks: ["量价等五维数据支撑不加仓判断，核心完成", "不加仓与触发条件可用；成交量误标万手"],
    rows: [
      {label:"成交量",values:["9月21、22日为9521万股、2.37亿股；数值单位正确", "覆盖四日但把万股标成万手；错误延伸到加仓阈值"],comparisonIndices:[0]},
      {label:"换手率",values:["9月21、22日为3.02%、7.52%，关联放量回落分析", "补充9月28、29日2.34%、1.52%，对比此前天量"],comparisonIndices:[1]},
      {label:"价格结构",values:["列9月21、22日开高低收、振幅及量比", "除9月21、22日外补两日结构，说明23元支撑待确认"],comparisonIndices:[2]},
      {label:"OBV结构",values:["仅给两个时点26.5万、28.87万，缺连续序列和量级解释", "七日序列显示连降5日、跌10.7%；仍高于前低"],comparisonIndices:[3]},
      {label:"股东户数",values:["给户数、户均持股、一年趋势及主力游资散户资金分层", "给最新户数与降幅，说明数据滞后；缺长期及资金分层"],comparisonIndices:[4]},
      {label:"趋势判断",values:["判为不良性，以量价、动量、事件、基本面与支撑闭合论证", "五维矩阵以定性标签为主，缺动量读数和基本面硬约束"],comparisonIndices:[5]},
      {label:"加仓条件",values:["不建议加仓，列价格企稳、订单兑现与财报改善三条信号", "不宜加仓，分批与失效阈值更细；放量阈值误标万手"],comparisonIndices:[6]},
      {label:"开头风险",values:["本方专属要求已满足：第一段明确投资风险", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[7]},
      {label:"耗时与用量",values:["约18.2秒；输入42581、输出1866 token", "约71.9秒；输入71488、输出16230 token"],comparisonIndices:[8]}
    ]
  },
  "cmp_04b73a03-958a-4040-ad6d-6fed44d560f3": {
    checks: ["量价与筹码数据齐且核对一致，给出加仓触发条件", "缺最新量换数据，股东户数及OBV方向有误"],
    rows: [
      {label:"成交量",values:["四日成交量齐备；最新仅为5日均量0.43倍", "缺9月29日量；称放量2.4倍，按所列均量应为3.31倍"],comparisonIndices:[0]},
      {label:"换手率",values:["四日换手齐备，最新1.52%远低于此前7.52%", "工具已返回9月29日1.515%，正文仍以破折号缺省"],comparisonIndices:[1]},
      {label:"价格结构",values:["四日开高低收齐，9月22、29日上影占比核算一致", "冲高回落定性吻合；高开写2.5元，实际缺口1.20元"],comparisonIndices:[2]},
      {label:"OBV结构",values:["OBV及两条均线与工具一致，回落方向和量价判断无矛盾", "称OBV跌10.6%小于股价跌6.7%，写反相对跌幅"],comparisonIndices:[3]},
      {label:"股东户数",values:["8月末457913户、降3.99%与披露一致，补充一年趋势", "三期户数均偏差2.5—4.2万户，集中度依据失真"],comparisonIndices:[4]},
      {label:"趋势判断",values:["修复未确认转强；冲高回落、OBV均线与量价证据连贯", "判断转向钝化，但户数错误及OBV方向错误削弱依据"],comparisonIndices:[5]},
      {label:"加仓条件",values:["给试仓、右侧加仓、止损与压力确认四场景及验证信号", "不建议加仓；按持有、空仓、激进者列预案与失效阈值"],comparisonIndices:[6]},
      {label:"开头风险",values:["本方专属要求已满足：结论后紧跟订单、需求等风险", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[7]},
      {label:"耗时与用量",values:["约52.8秒、6.3万 token；核心取舍仍看数据准确性", "约322.7秒、90.1万 token，资源消耗更高"],comparisonIndices:[8]}
    ]
  },
  "cmp_5a4a56d4-12eb-4776-9874-bcb66b35941a": {
    checks: ["六项逻辑有实质说明，四项公式映射不完整", "六项要素均覆盖，另交付106只名单及口径说明"],
    rows: [
      {label:"小阳条件",values:["完整说明收阳、高于昨收、涨幅小于3%三条件", "三条件解释完整；该格证据仍标待核实"],comparisonIndices:[0]},
      {label:"连续四日",values:["仅提连续4日，未明示M=4及计数公式窗口含义", "明确M=4连续小阳窗口，含滚动计数含义"],comparisonIndices:[1]},
      {label:"三十日窗口",values:["仅提近30日，未明示历史窗口内至少出现一次", "明确小阳段出现在信号日前30个交易日内"],comparisonIndices:[2]},
      {label:"回踩逻辑",values:["解释最低价不高于昨收，漏讲收盘低于昨收的或分支", "解释两分支，并指出收盘低于昨收与RECOVER冲突"],comparisonIndices:[3]},
      {label:"不破均线",values:["最低价与收盘价都高于20日均线，解释完整", "最低价与收盘价都高于20日均线，解释完整"],comparisonIndices:[4]},
      {label:"恢复与合成",values:["只概括收阳确认与复合逻辑，未映射RECOVER及四项合成", "恢复条件明确；四项合成有隐含表达，未逐字写出XG公式"],comparisonIndices:[5]},
      {label:"开头风险",values:["本方专属要求未满足：风险仅在文末，不构成另一方劣势", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[6]},
      {label:"耗时与用量",values:["更快且输出少，但未给筛选清单", "138.8秒、输出30966 token；另交付完整清单与口径"],comparisonIndices:[7]}
    ]
  },
  "cmp_0ab11224-7491-47c4-b603-06a9b0abedaa": {
    checks: ["95只与94只标准冲突，承诺的完整名单未交付", "仅代码块中的资源引用，无法核验数量或名单"],
    rows: [
      {label:"数量与名单",values:["工具支持95只，标准94只；仅列10只样本，完整名单空缺", "正文仅71字符资源引用，内部不可核验，无可读数量或名单"],comparisonIndices:[0]},
      {label:"开头风险",values:["本方专属要求已满足：开头说明形态回测非买入建议", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[1]},
      {label:"耗时与用量",values:["约71.2秒、输出1344 token；有数量和样本的部分交付", "约179.6秒、输出10983 token；无可读正文交付"],comparisonIndices:[2]}
    ]
  },
  "cmp_7ee8b926-2a87-4fd6-8c86-fbcd461f3403": {
    checks: ["月度及12月值有据，年度均值算错", "2019值与所引2017标准不符，基期换算矛盾"],
    rows: [
      {label:"CPI数值",values:["12月105.99区分于2017值；均值105.31算错，应105.485", "2019约105.2异于2017标准105.5；方向待核，基期换算矛盾"],comparisonIndices:[0]},
      {label:"资源指标",values:["未提供实质数据，无双方同种有效指标可比", "未提供实质数据，无双方同种有效指标可比"],comparisonIndices:[1]}
    ]
  },
  "cmp_b4509585-9f57-4ada-918d-da9f7d5c7508": {
    checks: ["四项涨幅均与标准一致，计算口径及来源齐全", "四项涨幅均正确，工具及上证基准可核算"],
    rows: [
      {label:"上证50涨幅",values:["12.90%与标准一致，正文及表格均有工具引用", "12.90%与标准一致，正文及表格可溯源"],comparisonIndices:[0]},
      {label:"50相对涨幅",values:["−5.51个百分点，展示差值计算；另列非必需复利口径", "−5.51个百分点，附上证18.41%基准便于核算"],comparisonIndices:[1]},
      {label:"2000涨幅",values:["36.42%与标准一致，工具结果另用新闻交叉印证", "36.42%与标准一致，可溯源工具36.4176%"],comparisonIndices:[2]},
      {label:"2000相对涨幅",values:["+18.01个百分点，展示差值计算；另列非必需复利口径", "+18.01个百分点，单列上证18.41%基准便于自检"],comparisonIndices:[3]},
      {label:"耗时与用量",values:["约104秒、74386 token；额外资源未增加核心交付", "约86秒、21919 token，资源较精简"],comparisonIndices:[4]}
    ]
  },
  "cmp_054c9606-e20b-43cd-86dc-87f884e5be51": {
    checks: ["归因确认四项条件均满足；对局仍待复核", "仅放宽后2158只统计，无满足全部条件的名单"],
    rows: []
  },
  "cmp_6ba043e1-2264-408b-83b5-34dc9198fd53": {
    checks: ["三项一致，长城涨幅因前复权口径偏离标准", "仅比亚迪涨幅一致，销量与长城涨幅口径偏离"],
    rows: [
      {label:"全年销量",values:["4602436辆，与标准逐字一致，引用产销快报", "4545400辆少57036辆；选乘用车口径且已披露"],comparisonIndices:[0]},
      {label:"前五月销量",values:["1405039辆，与标准一致，引用5月快报累计值", "1380100辆少24939辆；乘用车月度加总内部一致"],comparisonIndices:[1]},
      {label:"比亚迪涨幅",values:["−1.58%符合标准；区间为上年12月31日至5月29日", "−1.58%符合标准；原判认可1月5日至5月29日口径"],comparisonIndices:[2]},
      {label:"长城涨幅",values:["前复权−25.76%；标准不复权−25.36%，工具也返回后者", "如实引用工具−25.76%；较标准−25.36%差0.40个百分点"],comparisonIndices:[3]},
      {label:"开头风险",values:["本方专属要求已满足：开头有非投资建议提示", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[4]},
      {label:"耗时与用量",values:["35.818秒；66664 token", "90.952秒；129024 token"],comparisonIndices:[5]}
    ]
  },
  "cmp_a9c3fc3b-18e0-4e2a-af14-69e414facb00": {
    checks: ["列4家漏博腾股份，按9996万口径排除偏离标准", "列4家漏博腾股份，下限大于1亿口径偏离标准"],
    rows: [
      {label:"公司与金额",values:["4家匹配但漏博腾；华大图表2.51亿与正文5亿不一致", "4家名称金额匹配但漏博腾；表格无内部不一致"],comparisonIndices:[0]},
      {label:"截至时点",values:["明确截至2026年6月25日，查询覆盖6月1—25日", "截至6月25日，按6月1—25日实施公告筛选"],comparisonIndices:[1]},
      {label:"回购或增持",values:["筛回购，说明无回购方案的增持公司无拟回购金额字段", "讨论两路径；增持19家与高增长有重合，但回购交集为空"],comparisonIndices:[2]},
      {label:"一亿元门槛",values:["通常用上限大于1亿，博腾却改用9996万，口径不统一", "统一用下限大于1亿；博腾下限0.8亿被排除，与标准冲突"],comparisonIndices:[3]},
      {label:"一季度增长",values:["查询均纳入一季度归母净利同比大于50%", "1267家作基池，明确归母净利同比严格大于50%"],comparisonIndices:[4]},
      {label:"开头风险",values:["本方专属要求已满足：开头提示筛选非推荐及回购实施风险", "不适用；该开头风险要求仅约束回答①"],comparisonIndices:[5]},
      {label:"耗时与用量",values:["156.4秒；输入97120、输出771 token", "339.16秒；输入133559、输出25020 token"],comparisonIndices:[6]}
    ]
  }
};
