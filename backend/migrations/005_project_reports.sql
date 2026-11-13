-- Migration 005: Project reports table for n8n-generated reports
CREATE TABLE IF NOT EXISTS project_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID,
    card_id TEXT,
    report_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    details JSONB,
    board_id TEXT,
    generated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_reports_project_id ON project_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_project_reports_report_type ON project_reports(report_type);
CREATE INDEX IF NOT EXISTS idx_project_reports_created_at ON project_reports(created_at DESC);
