// 真实比较实验的离线快照；来源、固定材料与选样在 protocolSource 中记录。
window.EvaluationExperimentData = {
  "id": "report-comparison-stability-20261007",
  "generatedAt": "2026-10-06T17:05:59.765Z",
  "comparisonEvaluator": "r153",
  "upstreamEvaluators": [
    "r151",
    "r152"
  ],
  "protocolSource": ".artifacts/report-experiments-20261007/protocol.json",
  "runs": [
    {
      "id": "report-r153-original-1",
      "label": "原位一",
      "path": ".artifacts/report-experiments-20261007/runs/report-r153-original-1",
      "swapped": false
    },
    {
      "id": "report-r153-original-2",
      "label": "原位二",
      "path": ".artifacts/report-experiments-20261007/runs/report-r153-original-2",
      "swapped": false
    },
    {
      "id": "report-r153-swapped",
      "label": "交换 A/B",
      "path": ".artifacts/report-experiments-20261007/runs/report-r153-swapped",
      "swapped": true
    }
  ],
  "coverage": {
    "planned": 18,
    "decided": 18,
    "pending": 0,
    "failed": 0,
    "incomplete": 0
  },
  "metrics": {
    "repeat": {
      "label": "原位一 ↔ 原位二",
      "agree": 5,
      "paired": 6,
      "missing": 0,
      "interval": [
        0.43649717781352987,
        0.9699466302516935
      ],
      "coreAgree": 12,
      "corePaired": 12,
      "disagreements": [
        "cmp_d5c3e8cb-186c-4e63-a571-e9d20ef6cde1"
      ]
    },
    "swap": {
      "label": "原位一 ↔ 换位",
      "agree": 5,
      "paired": 6,
      "missing": 0,
      "interval": [
        0.43649717781352987,
        0.9699466302516935
      ],
      "coreAgree": 12,
      "corePaired": 12,
      "disagreements": [
        "cmp_d5c3e8cb-186c-4e63-a571-e9d20ef6cde1"
      ]
    }
  },
  "conclusion": "5 / 6 题三轮结论一致。同位重复也有变化，不能单独归因于位置。",
  "samples": [
    {
      "id": "cmp_d5c3e8cb-186c-4e63-a571-e9d20ef6cde1",
      "title": "中谷物流毛利率",
      "case": {
        "batch_id": "2026-09-22",
        "case_id": "公司事件与财报解读_20题_20260921_Q012"
      },
      "selection": "Fast；无标准；原判都好",
      "tier": "Fast",
      "hasStandardAnswer": false,
      "source": {
        "file": "data/runs/comparison/eval-20261006-215149/results/comparison.jsonl",
        "line": 1
      },
      "upstream": [
        {
          "label": "criteria",
          "taskId": "2e65b12b-32f9-4d2b-92fa-14ee53a97d13",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "A",
          "taskId": "9aa50a6c-d40b-413d-bd51-d250ff62ebdc",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "B",
          "taskId": "25f4472f-76b8-4974-808d-9dd35138d31e",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        }
      ],
      "results": [
        {
          "runId": "report-r153-original-1",
          "taskId": "0226a20f-8ef2-4abe-a132-f521c8088698",
          "comparisonId": "cmp_631e81c5-9473-47c5-81ca-93760af65335",
          "mapping": {
            "A": "a_fast",
            "B": "b_fast"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "win",
          "winner": "a_fast",
          "core": {
            "a_fast": true,
            "b_fast": true
          },
          "reason": "双方核心结论均可用：r1归因、r2可持续性均完整覆盖，无事实性失败。A组Fast在r2上以4家券商机构预期对比表与4条推翻判断信号清单相比B组Fast的1家研报+3条观察指标提供更宽的机构视野与可证伪边界，构成中高重要性的单方深度优势，因此偏好A组Fast。反向优势：B组Fast的trace引用更克制、PDCI数据无近似偏差。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-1/results/comparison.jsonl",
            "comparisonId": "cmp_631e81c5-9473-47c5-81ca-93760af65335"
          },
          "attempts": 1,
          "contentSubmissions": 1
        },
        {
          "runId": "report-r153-original-2",
          "taskId": "4082e047-8062-4ded-bacd-30727000b8c3",
          "comparisonId": "cmp_f6052049-2907-4094-a318-a6a973422989",
          "mapping": {
            "A": "a_fast",
            "B": "b_fast"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_good",
          "winner": null,
          "core": {
            "a_fast": true,
            "b_fast": true
          },
          "reason": "双方核心均可用。r1与r2的差异（A组Fast多一条营业成本因素、业务条线拆解与机构预期/信号清单）属分析深度差异，未达已确认中高重要性单方优势级别；B组Fast在token用量上以约A组Fast的38%更省但重要性低。综合来看双方交付各有特色但均无实质性可用差距，无需单方偏好。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-2/results/comparison.jsonl",
            "comparisonId": "cmp_f6052049-2907-4094-a318-a6a973422989"
          },
          "attempts": 1,
          "contentSubmissions": 3
        },
        {
          "runId": "report-r153-swapped",
          "taskId": "c5392285-7e7f-48ee-91ae-aa1dcb1adf24",
          "comparisonId": "cmp_eb5f183b-58cd-4422-8668-f5c8e353304b",
          "mapping": {
            "A": "b_fast",
            "B": "a_fast"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_good",
          "winner": null,
          "core": {
            "b_fast": true,
            "a_fast": true
          },
          "reason": "双方均满足r1/r2核心要求且无实质差距：B组Fast以三条简洁原因+两段判断覆盖全部要点，全部数据在trace源中可定位；A组Fast以表格化四条原因+三业务条线拆分+机构预期表提供更细颗粒度，但PDCI 1124点与8月运价上限两处轻微近似不影响主结论；按本题核心可用性，两者均为合格交付，无法据现有归因确认单方优势。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-swapped/results/comparison.jsonl",
            "comparisonId": "cmp_eb5f183b-58cd-4422-8668-f5c8e353304b"
          },
          "attempts": 1,
          "contentSubmissions": 1
        }
      ]
    },
    {
      "id": "cmp_67e0faf9-d1fa-49d1-8e74-7c78b9531eeb",
      "title": "华润电力利润下跌",
      "case": {
        "batch_id": "2026-09-22",
        "case_id": "公司事件与财报解读_20题_20260921_Q018"
      },
      "selection": "Fast；无标准；原判都差",
      "tier": "Fast",
      "hasStandardAnswer": false,
      "source": {
        "file": "data/runs/comparison/eval-20261006-215149/results/comparison.jsonl",
        "line": 3
      },
      "upstream": [
        {
          "label": "criteria",
          "taskId": "a1346ed5-82bf-42c8-94b7-33c7c07ec010",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "A",
          "taskId": "7b15c0ea-23e9-4aa5-b3c9-16011dc4a6cc",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "B",
          "taskId": "6121775b-d160-490a-91cd-150073973ee8",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        }
      ],
      "results": [
        {
          "runId": "report-r153-original-1",
          "taskId": "aea24dbf-01b3-40ac-89ce-64b48f3bdc4c",
          "comparisonId": "cmp_a22cfd84-98b5-42a3-9dca-e64d0ed7ccea",
          "mapping": {
            "A": "a_fast",
            "B": "b_fast"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_bad",
          "winner": null,
          "core": {
            "a_fast": false,
            "b_fast": false
          },
          "reason": "A组Fast因完整覆盖11年数据在r1优于B组Fast（A组Fast覆盖全部11年，B组Fast遗漏2019/2023/2024三个完整年度），但因将2022年(+229.5%)错误归为下跌使r2次数判断错（多计1次且与正文表格自相矛盾）；B组Fast按周期给出两次在r2比A组Fast的五次略合理，但r1覆盖缺失、r4中2022年引用子公司数据描述母公司存在主体错配；两方r3（未给出量化标准）和r4（各有事实/主体错配问题）均无实质差距，无法形成单方高重要性优势；A组Fast的r1覆盖优势涉及2015-2025全周期完整性，比B组Fast的r2次数优势影响更直接。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-1/results/comparison.jsonl",
            "comparisonId": "cmp_a22cfd84-98b5-42a3-9dca-e64d0ed7ccea"
          },
          "attempts": 1,
          "contentSubmissions": 4
        },
        {
          "runId": "report-r153-original-2",
          "taskId": "d844ec05-e052-4d47-a456-943d2dd7cfec",
          "comparisonId": "cmp_ab1459d4-e896-4626-a283-70876dd5fccd",
          "mapping": {
            "A": "a_fast",
            "B": "b_fast"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_bad",
          "winner": null,
          "core": {
            "a_fast": false,
            "b_fast": false
          },
          "reason": "A组Fast核心优势是r1完整覆盖11年净利润变化与2021年归因的具体拆解数据可与年报交叉验证，对用户判断华润电力2015-2025净利润走势提供实际可用的整体框架；其2022年自相矛盾与2018最低点错误虽损害可信度但影响局部。B组Fastr2次数判断更清晰（两次显著下跌，正文标注2022反弹），但缺失2019/2023/2024三个完整年度使r1仅partial，且2022年用子公司亏损数据描述母公司构成主体错配错误。综合而言，A组Fast的覆盖完整性与2021拆解深度对本题实际判断的支撑更充分，B组Fast的r2 met与诚实标注推测不足以抵消r1 partial与主体错配带来的核心可用性损失。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-2/results/comparison.jsonl",
            "comparisonId": "cmp_ab1459d4-e896-4626-a283-70876dd5fccd"
          },
          "attempts": 1,
          "contentSubmissions": 2
        },
        {
          "runId": "report-r153-swapped",
          "taskId": "08d8821f-fca0-46bb-b99e-98c860ff36ed",
          "comparisonId": "cmp_2c02d2f4-c9fb-4495-b971-f43d99210e6a",
          "mapping": {
            "A": "b_fast",
            "B": "a_fast"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_bad",
          "winner": null,
          "core": {
            "b_fast": false,
            "a_fast": false
          },
          "reason": "双方核心均不可用（meets_core均为false），各存在多个高重要性缺陷。B组Fast的下跌次数判断（2次事件，约3-4年实际下跌）较A组Fast（5次且错误包含恢复年2022）更接近实际数据，所引数据值与FinQuery精确一致并显式承认2016-2017年原因为推测；A组Fast拥有完整11年数据覆盖和2021年详细数值拆解，但'2018最低点'与同表2021数据直接矛盾、2022注解-11.8亿与表格+229.5%自相矛盾、计数多1次等核心事实错误会直接误导用户对华润电力净利润变化规律的理解。综合核心问题（次数与原因）的准确性，B组Fast的交付更可被用户信赖使用，A组Fast的覆盖完整与2021拆解详细优势无法抵消其事实错误对核心结论的破坏。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-swapped/results/comparison.jsonl",
            "comparisonId": "cmp_2c02d2f4-c9fb-4495-b971-f43d99210e6a"
          },
          "attempts": 1,
          "contentSubmissions": 1
        }
      ]
    },
    {
      "id": "cmp_3374583d-2521-468f-9363-0d5e8898fc02",
      "title": "同花顺股东增减持",
      "case": {
        "batch_id": "2026-09-24",
        "case_id": "客观题2500条补充_带标准答案_with_gt_客观题_00169"
      },
      "selection": "Fast；有标准；原判单方胜",
      "tier": "Fast",
      "hasStandardAnswer": true,
      "source": {
        "file": "data/runs/comparison/eval-20261006-215149/results/comparison.jsonl",
        "line": 12
      },
      "upstream": [
        {
          "label": "criteria",
          "taskId": "660b6059-017d-4070-a29b-38f777e1a173",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "A",
          "taskId": "603b0e7a-ccd9-44ce-a782-5ed22c3389b4",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "B",
          "taskId": "4251a476-e2bd-4323-acb4-ca9073fca66c",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        }
      ],
      "results": [
        {
          "runId": "report-r153-original-1",
          "taskId": "bc010db8-441f-4042-be6c-c27757e292a9",
          "comparisonId": "cmp_011dc854-9dce-4ce0-a95a-7a3c2a323411",
          "mapping": {
            "A": "a_fast",
            "B": "b_fast"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "win",
          "winner": "a_fast",
          "core": {
            "a_fast": true,
            "b_fast": false
          },
          "reason": "A组Fast同时满足r1与r2两条核心要求，数据由FinQuery工具直接支持；B组Fast仅r1满足，r2因股东身份编造与核心数值标记缺失而完全失败，标准答案第二条关键事实不可用。A组Fast在核心结果可用性上具有决定性优势，故偏好A组Fast。B组Fast虽耗时更长、调用更多工具，但未能转化为更好的数据交付，资源差异不构成反向优势。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-1/results/comparison.jsonl",
            "comparisonId": "cmp_011dc854-9dce-4ce0-a95a-7a3c2a323411"
          },
          "attempts": 2,
          "contentSubmissions": 1
        },
        {
          "runId": "report-r153-original-2",
          "taskId": "65367da0-c125-4fc1-adcd-c0d8cb88cf8b",
          "comparisonId": "cmp_61c8257e-a999-4805-bf61-f8c07da63d94",
          "mapping": {
            "A": "a_fast",
            "B": "b_fast"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "win",
          "winner": "a_fast",
          "core": {
            "a_fast": true,
            "b_fast": false
          },
          "reason": "A组Fast同时满足r1与r2两条核心要求（杭州凯士顺699100股、叶琼玖2000000股），仅结尾引导问句轻微缺失；B组Fast满足r1但r2将股东错写为王进且股数标为数据缺失，整体核心交付不可用。r2为核心事实，缺失即定胜负，因此偏好A组Fast。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-2/results/comparison.jsonl",
            "comparisonId": "cmp_61c8257e-a999-4805-bf61-f8c07da63d94"
          },
          "attempts": 1,
          "contentSubmissions": 1
        },
        {
          "runId": "report-r153-swapped",
          "taskId": "7b795706-b8c0-43e2-af4d-c19d0e01f894",
          "comparisonId": "cmp_27f5a88f-5003-4b20-a14d-9289ef4b932f",
          "mapping": {
            "A": "b_fast",
            "B": "a_fast"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "win",
          "winner": "a_fast",
          "core": {
            "b_fast": false,
            "a_fast": true
          },
          "reason": "A组Fast两条核心记录均完整准确（杭州凯士顺699,100股、叶琼玖2,000,000股），B组Fast第二条股东身份错误写成王进、股数缺失，整体第二条核心事实不可用，A组Fast在核心可用性上具有已确认的高重要性单方优势。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-swapped/results/comparison.jsonl",
            "comparisonId": "cmp_27f5a88f-5003-4b20-a14d-9289ef4b932f"
          },
          "attempts": 1,
          "contentSubmissions": 1
        }
      ]
    },
    {
      "id": "cmp_b4509585-9f57-4ada-918d-da9f7d5c7508",
      "title": "中证2000与上证50涨幅",
      "case": {
        "batch_id": "2026-09-24",
        "case_id": "客观题2500条补充_带标准答案_with_gt_客观题_00941"
      },
      "selection": "Expert；有标准；原判都好",
      "tier": "Expert",
      "hasStandardAnswer": true,
      "source": {
        "file": "data/runs/comparison/eval-20261006-215149/results/comparison.jsonl",
        "line": 17
      },
      "upstream": [
        {
          "label": "criteria",
          "taskId": "a3604b0b-fd35-49d5-8926-2d7d1ec646ec",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "A",
          "taskId": "2b1adc7e-2a33-4bf0-9fa2-9761b748b0cc",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "B",
          "taskId": "c953ef17-1908-430d-8f2e-23480334cec1",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        }
      ],
      "results": [
        {
          "runId": "report-r153-original-1",
          "taskId": "f51323ce-6e97-483d-a4a6-fe0b8eae2793",
          "comparisonId": "cmp_f88495c9-c96d-4f60-948e-504f75971eea",
          "mapping": {
            "A": "b_expert",
            "B": "a_expert"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_good",
          "winner": null,
          "core": {
            "b_expert": true,
            "a_expert": true
          },
          "reason": "双方四个核心数值（12.90%、-5.51pct、36.42%、+18.01pct）均与标准答案逐项一致，核心交付均可用；B组Expert在表格中显式列出上证指数基准18.41%便于自检，A组Expert额外给出复利收益倍数与公开新闻交叉印证，二者核心交付上无实质差距，不形成单方决定性优势。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-1/results/comparison.jsonl",
            "comparisonId": "cmp_f88495c9-c96d-4f60-948e-504f75971eea"
          },
          "attempts": 1,
          "contentSubmissions": 1
        },
        {
          "runId": "report-r153-original-2",
          "taskId": "17bd4046-6b64-488e-9b76-639374db8ef6",
          "comparisonId": "cmp_2e92b113-9ee6-456d-86b8-d2d95be183e0",
          "mapping": {
            "A": "b_expert",
            "B": "a_expert"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_good",
          "winner": null,
          "core": {
            "b_expert": true,
            "a_expert": true
          },
          "reason": "双方四项核心数值（12.90%/-5.51/36.42%/+18.01）均与标准答案逐项一致，核心交付完整可用；B组Expert的表内基准行与A组Expert的'百分点差+收益倍数'双口径列均为辅助呈现形式差异，双方都能满足用户对四个涨幅数值的查询，不构成实质差距。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-2/results/comparison.jsonl",
            "comparisonId": "cmp_2e92b113-9ee6-456d-86b8-d2d95be183e0"
          },
          "attempts": 1,
          "contentSubmissions": 1
        },
        {
          "runId": "report-r153-swapped",
          "taskId": "5d750fa6-8f9e-49ff-9146-75622e175816",
          "comparisonId": "cmp_cb7a2d61-6083-458a-a957-b881e7a88111",
          "mapping": {
            "A": "a_expert",
            "B": "b_expert"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_good",
          "winner": null,
          "core": {
            "a_expert": true,
            "b_expert": true
          },
          "reason": "双方四项核心数值（12.90%、-5.51pct、36.42%、+18.01pct）均与标准答案逐项一致且可追溯到真实工具结果，核心交付都可用且没有实质差距，不构成胜负；A组Expert 额外给出复利收益倍数口径和公开新闻交叉印证，B组Expert 在表格中并列上证指数基准且总用量更少但伴随低重要度图文措辞瑕疵，整体互有微小附加项。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-swapped/results/comparison.jsonl",
            "comparisonId": "cmp_cb7a2d61-6083-458a-a957-b881e7a88111"
          },
          "attempts": 1,
          "contentSubmissions": 1
        }
      ]
    },
    {
      "id": "cmp_6ba043e1-2264-408b-83b5-34dc9198fd53",
      "title": "比亚迪销量与股价",
      "case": {
        "batch_id": "2026-09-25",
        "case_id": "客观题2500条补充_带标准答案_with_gt_客观题_02211"
      },
      "selection": "Expert；有标准冲突；原判都差",
      "tier": "Expert",
      "hasStandardAnswer": true,
      "source": {
        "file": "data/runs/comparison/eval-20261006-215149/results/comparison.jsonl",
        "line": 24
      },
      "upstream": [
        {
          "label": "criteria",
          "taskId": "97369282-f164-49a2-84b4-6eacae7fe7d3",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "A",
          "taskId": "0f2c3cbb-dcec-47bf-9644-f17aebdd838c",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "B",
          "taskId": "4323acbb-3b48-4e4c-b736-03cba990b20f",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        }
      ],
      "results": [
        {
          "runId": "report-r153-original-1",
          "taskId": "fb871c3b-9bad-4dce-bff2-943eba87c0f5",
          "comparisonId": "cmp_8bf0e528-3434-466b-99d4-fd21ff7f2eb2",
          "mapping": {
            "A": "a_expert",
            "B": "b_expert"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_bad",
          "winner": null,
          "core": {
            "a_expert": false,
            "b_expert": false
          },
          "reason": "A组Expert在比亚迪2025年销量（r1）和2026年1-5月销量（r2）两项high级判据上与GT完全exact一致；B组Expert这两项因采用乘用车宏观口径分别差57,036辆和24,939辆，构成已确认的high级单方优势。两者在长城汽车涨跌幅（r4）上问题相同（均-25.76%，差0.4pp），在比亚迪涨跌幅（r3）上均完全一致，故A组Expert在销量准确性上的优势不受抵消。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-1/results/comparison.jsonl",
            "comparisonId": "cmp_8bf0e528-3434-466b-99d4-fd21ff7f2eb2"
          },
          "attempts": 1,
          "contentSubmissions": 2
        },
        {
          "runId": "report-r153-original-2",
          "taskId": "1ec3fba7-fe00-478d-9742-5c500ff9afd5",
          "comparisonId": "cmp_e6302ef9-2ccb-4d26-9f85-198476ea53be",
          "mapping": {
            "A": "a_expert",
            "B": "b_expert"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_bad",
          "winner": null,
          "core": {
            "a_expert": false,
            "b_expert": false
          },
          "reason": "A组Expert的比亚迪2025年销量与2026年1-5月销量与标准答案完全一致，比B组Expert分别差约1.2%和1.8%（B组Expert采用乘用车宏观口径而GT采用公司总销量口径）；r4长城汽车涨幅双方都因工具前复权口径与GT差0.4pp，A组Expert本轮更靠近GT核心数值。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-2/results/comparison.jsonl",
            "comparisonId": "cmp_e6302ef9-2ccb-4d26-9f85-198476ea53be"
          },
          "attempts": 1,
          "contentSubmissions": 1
        },
        {
          "runId": "report-r153-swapped",
          "taskId": "cc1389b8-2075-4f51-81c1-9fa21bf5eb0e",
          "comparisonId": "cmp_39c45258-911b-4f02-a0c9-5a0ef6ab5a51",
          "mapping": {
            "A": "b_expert",
            "B": "a_expert"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "both_bad",
          "winner": null,
          "core": {
            "b_expert": false,
            "a_expert": false
          },
          "reason": "A组Expert在两项高重要性的销量数据（r1、r2）上与GT完全一致，而B组Expert采用乘用车宏观口径导致偏离GT约57,036辆和24,939辆，构成核心数值差异。两者在长城汽车涨跌幅（r4）上存在相同0.40pp口径差异，比亚迪股价（r3）均与GT一致；A组Expert还在投资风险提示和资源用量上有明显优势。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-swapped/results/comparison.jsonl",
            "comparisonId": "cmp_39c45258-911b-4f02-a0c9-5a0ef6ab5a51"
          },
          "attempts": 1,
          "contentSubmissions": 1
        }
      ]
    },
    {
      "id": "cmp_04b73a03-958a-4040-ad6d-6fed44d560f3",
      "title": "歌尔股份趋势与加仓",
      "case": {
        "batch_id": "2026-09-29",
        "case_id": "线上问句0922-0923清洗6600条_线上问句_00188"
      },
      "selection": "Expert；无标准；原判单方胜",
      "tier": "Expert",
      "hasStandardAnswer": false,
      "source": {
        "file": "data/runs/comparison/eval-20261006-215149/results/comparison.jsonl",
        "line": 36
      },
      "upstream": [
        {
          "label": "criteria",
          "taskId": "9b3a0bc3-19a6-4205-822f-01fff93e1cda",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "A",
          "taskId": "57c27fd3-38bd-4a79-9079-38c19619ab47",
          "evaluator": "r151",
          "judge": "MiniMax-M3"
        },
        {
          "label": "B",
          "taskId": "5dc8142b-808e-455f-a98b-e81b185f4bfa",
          "evaluator": "r152",
          "judge": "MiniMax-M3"
        }
      ],
      "results": [
        {
          "runId": "report-r153-original-1",
          "taskId": "af6d3a7a-dfdd-41e8-9cdb-999941f69530",
          "comparisonId": "cmp_fdca6bcd-f774-4fa0-8da1-1bea2d3c0db8",
          "mapping": {
            "A": "b_expert",
            "B": "a_expert"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "win",
          "winner": "a_expert",
          "core": {
            "b_expert": false,
            "a_expert": true
          },
          "reason": "A组Expert七项共同要求逐项满足且技术数据与原始工具返回一致，右侧趋势定性为修复段未确认转强、加仓场景化方案支撑数字可核验。B组Expert结论先行与三档预案框架完整，但近二个交易日中9/29量价缺失、股东户数三档全错、OBV方向写反等数据问题直接影响右侧趋势判断的可信度，构成核心可用性差距，因此偏好A组Expert。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-1/results/comparison.jsonl",
            "comparisonId": "cmp_fdca6bcd-f774-4fa0-8da1-1bea2d3c0db8"
          },
          "attempts": 1,
          "contentSubmissions": 2
        },
        {
          "runId": "report-r153-original-2",
          "taskId": "3141e7c6-ab0e-4cf7-a8f2-15af9903bfe4",
          "comparisonId": "cmp_3dbe77bc-8804-47cd-b69f-1732d6756703",
          "mapping": {
            "A": "b_expert",
            "B": "a_expert"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "win",
          "winner": "a_expert",
          "core": {
            "b_expert": false,
            "a_expert": true
          },
          "reason": "B组Expert 在框架、叙事性与可视化方面完整，但股东户数三档数值全部错误、9/29成交量与换手率本可获取却标缺失、OBV/价格跌幅方向对比写反等核心数据错误直接影响复核可信度，core可用性受损；A组Expert 在七项共同要求、数据准确性、风险提示与引导问句全部满足，core可用且稳定，判定偏好A组Expert。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-original-2/results/comparison.jsonl",
            "comparisonId": "cmp_3dbe77bc-8804-47cd-b69f-1732d6756703"
          },
          "attempts": 1,
          "contentSubmissions": 2
        },
        {
          "runId": "report-r153-swapped",
          "taskId": "8956145a-fe2d-4c5f-ae2a-2e9fb767571e",
          "comparisonId": "cmp_2cf85625-5b65-42b2-8992-8951d027c7de",
          "mapping": {
            "A": "a_expert",
            "B": "b_expert"
          },
          "status": "decided",
          "evaluator": "r153",
          "judge": "MiniMax-M3",
          "outcome": "win",
          "winner": "a_expert",
          "core": {
            "a_expert": true,
            "b_expert": false
          },
          "reason": "A组Expert七项共同要求全部满足且核心数据与工具返回值一致，右侧趋势判断与加仓执行方案自洽；B组Expert交付框架（K线/OBV图、三档预案）完整但股东户数三档全部错误、9/29成交量与换手率缺失、OBV/价格跌幅方向写反，使核心可用性显著高于B组Expert。B组Expert唯一可用的是加仓判断方向（不建议）与量价下行证据一致，但支撑分析中数据错误使结论失去复核基础。",
          "source": {
            "file": ".artifacts/report-experiments-20261007/runs/report-r153-swapped/results/comparison.jsonl",
            "comparisonId": "cmp_2cf85625-5b65-42b2-8992-8951d027c7de"
          },
          "attempts": 1,
          "contentSubmissions": 2
        }
      ]
    }
  ]
};
