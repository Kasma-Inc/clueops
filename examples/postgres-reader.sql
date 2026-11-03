-- DBA按目标数据库/schema/表改写并执行；密码另由凭证管理流程设置。
CREATE ROLE diagnostic_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 4;
ALTER ROLE diagnostic_reader SET default_transaction_read_only = on;
ALTER ROLE diagnostic_reader SET statement_timeout = '10s';
ALTER ROLE diagnostic_reader SET lock_timeout = '2s';
ALTER ROLE diagnostic_reader SET idle_in_transaction_session_timeout = '15s';
GRANT CONNECT ON DATABASE target_database TO diagnostic_reader;
GRANT USAGE ON SCHEMA application TO diagnostic_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA application TO diagnostic_reader;
-- 对实际建表owner重复设置，避免后续表没有权限。
ALTER DEFAULT PRIVILEGES FOR ROLE application_owner IN SCHEMA application GRANT SELECT ON TABLES TO diagnostic_reader;
-- 仅在接受跨数据库运行信息可见性时额外授权：
-- GRANT pg_read_all_stats TO diagnostic_reader;
-- 不授予写权限、危险函数、外部连接扩展、超级用户或BYPASSRLS。
-- PUBLIC默认CONNECT/TEMP、函数EXECUTE权限及SECURITY DEFINER函数须按实际环境审查。
