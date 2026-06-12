-- Oracle PL/SQL intermingled with SQL: block keywords as the { } family,
-- keyword vs builtin split, '' escapes, q-quoting, := <> .. operators.
CREATE OR REPLACE PROCEDURE raise_salary(p_id IN NUMBER, p_pct IN NUMBER) IS
  v_name  VARCHAR2(100);
  v_msg   VARCHAR2(200) := 'it''s a 5% raise';
  v_qmsg  VARCHAR2(200) := q'[no need to double 'quotes' here]';
BEGIN
  SELECT NVL(ename, 'unknown') INTO v_name
    FROM emp
   WHERE empno = p_id AND deptno <> 99;

  IF p_pct > 0 THEN
    UPDATE emp SET sal = ROUND(sal * (1 + p_pct / 100), 2) WHERE empno = p_id;
  ELSIF p_pct = 0 THEN
    NULL;
  ELSE
    RAISE_APPLICATION_ERROR(-20001, 'negative: ' || TO_CHAR(p_pct));
  END IF;

  FOR i IN 1..3 LOOP
    INSERT INTO audit_log("User", note) VALUES (USER, SUBSTR(v_msg, 1, 50));
  END LOOP;

  CASE WHEN p_pct > 10 THEN COMMIT; ELSE ROLLBACK; END CASE;
END;
