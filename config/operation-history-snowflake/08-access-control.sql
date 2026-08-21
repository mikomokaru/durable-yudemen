-- Operation History — 機密業務データの分類と承認済み分析担当者への access 制御（operation-history-log タスク 13.6）
-- 要件: 6.10 / 6.11 / 6.12
--
-- 所有者は Data Platform である。01〜07 の後に、最後に実行する（手順は
-- docs/operation-history/snowflake-access-procedure.md）。Producer 設定の SSOT（root wrangler.jsonc）へ
-- role も grant も一切足さない（要件 4.10 / 4.13 / 4.14）。
--
-- この層が持つのは三つだけである。
--   分類（要件 6.10）  … tag 一つ、許可値一つ。「個人情報ではない機密業務データ」を一語で表す。
--   許可（要件 6.11）  … role 一つ。与える権限は SELECT と USAGE だけである。
--   拒否（要件 6.12）  … Snowflake の既定拒否そのもの。ゆえに拒否のための文を一つも書かない。
--
-- 拒否は read-only である（要件 6.12）
--   このファイルは DML（INSERT / UPDATE / DELETE / MERGE / TRUNCATE / COPY）を一つも持たず、task も alert も
--   procedure も作らない。ゆえに「未承認主体がアクセスを要求した」ことを契機に走る文が存在せず、拒否で
--   Operation Record、品質指標、分析結果、アクセス承認状態のいずれも変わらない。拒否の記録を残すために
--   table へ書くこともしない（書けば拒否が write になる）。監査は Snowflake 側の query history が持つ。
--
-- 承認済み分析担当者の実名をリポジトリへ置かない
--   アクセス承認状態は role member（GRANT ROLE ... TO USER）である。これは credential と同じ規律で扱い、
--   運用者が手順書に従って与える。ゆえにこのファイルに GRANT ROLE も CREATE USER も無い。誰が承認済みかを
--   リポジトリが知らないことは、access 制御の欠落ではなく、承認状態の正本が Snowflake 側にあることの表明で
--   ある（要件 6.11 の「アクセス承認状態」）。
--
-- 分類は object tagging を使う（Enterprise Edition 以上）
--   tag は許可値を宣言できるため、分類の語が二つに増えない。account が Standard Edition の場合、この文は
--   失敗する。そのときは分類の第二の正本（COMMENT や別 table）を発明せず、手順書 §1 に従って停止し
--   ユーザーへ確認する（fail closed）。

-- 分類 tag だけを置く schema。record も指標も分析結果も持たない。
CREATE SCHEMA IF NOT EXISTS OPERATION_HISTORY.GOVERNANCE
  COMMENT = '分類 tag だけを置く schema（要件 6.10）。record・品質指標・分析結果を持たない';

-- Operation Record の分類（要件 6.10）。
--
-- ALLOWED_VALUES を一値にすることが分類の要点である。値を自由文字列にすると、同じ database に
-- 'confidential'、'internal'、'PII' のような第二・第三の語が後から付き、どれが正本か分からなくなる。
-- 一値なら、tag が付いているか否かだけが問いになる。
--
-- 値は二つのことを同時に言う。個人情報ではない（自然人属性を record が持たない。要件 2.16 / 2.17）、
-- かつ機密業務データである（店舗の operation を復元できる）。前者だけを言うと保護が緩む方向へ、後者だけを
-- 言うと個人情報の手続きを持ち込む方向へ、それぞれ読み違えられる。
CREATE TAG IF NOT EXISTS OPERATION_HISTORY.GOVERNANCE.DATA_CLASSIFICATION
  ALLOWED_VALUES 'confidential-business-non-personal'
  COMMENT = 'Operation Record の分類。個人情報ではない機密業務データ（要件 6.10）';

-- database へ一度だけ付ける。tag は securable object の階層を下に継承されるため、RAW と ANALYSIS の
-- 全 table・view・列と、後から足す層の object も同じ分類を持つ。object ごとに付け直すと、付け忘れた object
-- だけが分類の外へ落ちる。
ALTER DATABASE OPERATION_HISTORY
  SET TAG OPERATION_HISTORY.GOVERNANCE.DATA_CLASSIFICATION = 'confidential-business-non-personal';

-- 承認済み分析担当者の role（要件 6.11 / 6.12）。
--
-- role は一つである。record を読める役と品質指標を読める役と分析結果を読める役を分けない。要件が承認の
-- 単位を「Operation_Record、品質指標、または分析結果へのアクセス」と一つに定めているため、役を分ければ
-- 承認状態が三つになり、どれが承認済みかの答えが割れる。
--
-- この role は読むだけである。閾値（OPERATION_QUALITY_THRESHOLD）と通知先
-- （OPERATION_ARRIVAL_NOTIFICATION_TARGET）の投入、task と alert の起動、通知の送信はいずれも運用者の
-- 権限であり、この role には与えない。ゆえに承認済みであっても Operation Record、品質指標、分析結果を
-- 変えられない。
CREATE ROLE IF NOT EXISTS OPERATION_HISTORY_ANALYST
  COMMENT = '承認済み分析担当者。record・品質指標・分析結果を読むだけ（要件 6.11 / 6.12）';

-- 読める範囲は database 単位で一度だけ宣言する（要件 6.11）。
--
-- object を列挙しない。列挙すると、層を足すたびに grant の追記を忘れた object が承認済み分析担当者から
-- 見えなくなる（要件 6.11 の未達）。ALL は今ある object、FUTURE はこれから作る object を覆う。
--
-- FUTURE は database 単位だけに置く。schema 単位の future grant を併置すると、Snowflake は schema 側を
-- 優先して database 側を無視するため、覆う範囲が静かに縮む。
--
-- 与える権限は USAGE（database / schema / 関数）と SELECT（table / view）だけである。INSERT、UPDATE、
-- DELETE、TRUNCATE、OWNERSHIP、MODIFY、MONITOR、OPERATE、EXECUTE TASK、APPLY を与えない。
GRANT USAGE  ON DATABASE OPERATION_HISTORY                    TO ROLE OPERATION_HISTORY_ANALYST;
GRANT USAGE  ON ALL SCHEMAS IN DATABASE OPERATION_HISTORY     TO ROLE OPERATION_HISTORY_ANALYST;
GRANT USAGE  ON FUTURE SCHEMAS IN DATABASE OPERATION_HISTORY  TO ROLE OPERATION_HISTORY_ANALYST;
GRANT SELECT ON ALL TABLES IN DATABASE OPERATION_HISTORY      TO ROLE OPERATION_HISTORY_ANALYST;
GRANT SELECT ON FUTURE TABLES IN DATABASE OPERATION_HISTORY   TO ROLE OPERATION_HISTORY_ANALYST;
GRANT SELECT ON ALL VIEWS IN DATABASE OPERATION_HISTORY       TO ROLE OPERATION_HISTORY_ANALYST;
GRANT SELECT ON FUTURE VIEWS IN DATABASE OPERATION_HISTORY    TO ROLE OPERATION_HISTORY_ANALYST;
-- 月次到達 SLO は view ではなく table function（OPERATION_ARRIVAL_SLO）である。呼ぶには USAGE が要る。
-- procedure（SEND_ARRIVAL_LAG_NOTIFICATION）は通知を送る側ゆえ与えない。
GRANT USAGE  ON ALL FUNCTIONS IN DATABASE OPERATION_HISTORY   TO ROLE OPERATION_HISTORY_ANALYST;
GRANT USAGE  ON FUTURE FUNCTIONS IN DATABASE OPERATION_HISTORY TO ROLE OPERATION_HISTORY_ANALYST;

-- 読むための compute。warehouse は運用資源ゆえプレースホルダである。実行時に置換し、置換後のファイルを
-- commit しない（README「credential」と同じ規律）。保持 task や alert の warehouse と同じものを使ってもよいが、
-- 分析担当者の ad-hoc query が運用 job の compute を奪わないよう別に置ける形にしてある。
GRANT USAGE ON WAREHOUSE <OPERATION_HISTORY_ANALYST_WAREHOUSE> TO ROLE OPERATION_HISTORY_ANALYST;
