SELECT status, count(*) AS n FROM transfers GROUP BY status ORDER BY n DESC;
UPDATE accounts a SET balance = j.s FROM (SELECT "accountId", sum(amount) s FROM ledger_entries GROUP BY "accountId") j WHERE j."accountId" = a.id AND a.balance <> j.s;
