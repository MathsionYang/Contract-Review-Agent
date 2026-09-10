// 合同审查工作台应用程序
const app = {
    // 当前状态
    currentView: 'home',
    currentTaskId: null,
    selectedRiskId: null,

    // 模拟数据存储
    tasks: [
        {
            id: 1,
            title: '【采购合同】ABC公司办公设备采购合同',
            type: 'procurement',
            status: 'working',
            riskCount: 8,
            createdAt: '2026-09-10 09:30'
        },
        {
            id: 2,
            title: '【软件开发】CRM系统定制开发合同',
            type: 'software_development',
            status: 'partial',
            riskCount: 12,
            createdAt: '2026-09-09 14:20'
        },
        {
            id: 3,
            title: '【房屋租赁】北京办公室租赁合同',
            type: 'property_lease',
            status: 'completed',
            riskCount: 6,
            createdAt: '2026-09-08 16:45'
        }
    ],

    risks: [
        {
            id: 'risk_001',
            level: 'critical',
            category: 'legal',
            topic: 'breach_liability',
            title: '违约责任条款失衡',
            description: '第6.1条约定乙方逾期交付每日支付合同总价5%的违约金，累计违约金可能远超合同总价，存在显失公平风险。',
            location: '第六条第6.1款',
            page: 1,
            legalBasis: [
                {
                    title: '《中华人民共和国民法典》',
                    article: '第五百八十五条',
                    content: '当事人可以约定一方违约时应当根据违约情况向对方支付一定数额的违约金...'
                }
            ],
            suggestion: '建议将违约金比例调整为每日0.5%，并约定违约金总额不超过合同总价的20%。',
            confidence: 0.92,
            status: 'pending_review'
        },
        {
            id: 'risk_002',
            level: 'high',
            category: 'commercial',
            topic: 'payment_condition',
            title: '付款条件与验收标准存在风险',
            description: '第4.3条约定甲方未在7个工作日内提出异议即视为验收合格，可能导致甲方丧失质量异议权。',
            location: '第四条第4.3款',
            page: 1,
            legalBasis: [
                {
                    title: '《中华人民共和国民法典》合同编',
                    article: '第六百一十条',
                    content: '因标的物质量不符合要求，致使不能实现合同目的的，买受人可以拒绝接受标的物...'
                }
            ],
            suggestion: '建议明确验收标准和验收程序，延长验收期限至15个工作日，并保留隐蔽瑕疵的异议权。',
            confidence: 0.88,
            status: 'pending_review'
        },
        {
            id: 'risk_003',
            level: 'high',
            category: 'text_quality',
            topic: 'cross_reference',
            title: '附件引用缺失',
            description: '第2.2条和第2.3条多次引用附件《设备清单及技术规格表》，但合同正文未确认附件是否存在及其法律效力。',
            location: '第二条第2.2款、第2.3款',
            page: 1,
            legalBasis: [],
            suggestion: '建议在合同末尾增加"附件清单"条款，明确附件名称、页数及与正文的法律效力关系。',
            confidence: 0.95,
            status: 'pending_review'
        },
        {
            id: 'risk_004',
            level: 'medium',
            category: 'commercial',
            topic: 'quality_assurance',
            title: '质保期责任范围不明确',
            description: '第5.2条仅约定"因质量问题"免费维修，但未明确质量问题的判定标准和举证责任。',
            location: '第五条第5.2款',
            page: 1,
            legalBasis: [],
            suggestion: '建议明确质量问题的判定依据（如国家标准、行业标准或合同约定标准），并约定质量问题由乙方承担举证责任。',
            confidence: 0.82,
            status: 'pending_review'
        },
        {
            id: 'risk_005',
            level: 'medium',
            category: 'text_quality',
            topic: 'amount_consistency',
            title: '金额表述不一致',
            description: '第3.1条合同总价大写为"伍拾万元整"，但未明确币种（人民币）在大写金额中的位置。',
            location: '第三条第3.1款',
            page: 1,
            legalBasis: [],
            suggestion: '建议修改为"人民币伍拾万元整"，确保大小写金额完整一致。',
            confidence: 0.90,
            status: 'pending_review'
        },
        {
            id: 'risk_006',
            level: 'medium',
            category: 'company_policy',
            topic: 'approval_authority',
            title: '预付款比例超出公司制度',
            description: '第3.2条约定30%预付款，根据公司《采购管理制度》，预付款比例不应超过20%。',
            location: '第三条第3.2款',
            page: 1,
            legalBasis: [],
            suggestion: '建议将预付款比例调整为20%，或提交财务部门和管理层审批。',
            confidence: 0.85,
            status: 'pending_review'
        },
        {
            id: 'risk_007',
            level: 'low',
            category: 'text_quality',
            topic: 'dispute_resolution',
            title: '争议解决条款可优化',
            description: '第7.2条仅约定可向甲方所在地法院起诉，未考虑仲裁等其他争议解决方式。',
            location: '第七条第7.2款',
            page: 1,
            legalBasis: [],
            suggestion: '建议补充仲裁条款，或明确约定管辖法院的具体名称。',
            confidence: 0.75,
            status: 'pending_review'
        },
        {
            id: 'risk_008',
            level: 'low',
            category: 'text_quality',
            topic: 'signature',
            title: '授权代表签字条款不完整',
            description: '合同末尾仅预留"法定代表人或授权代表签字"，但未要求提供授权委托书或说明授权代表的授权范围。',
            location: '合同签署栏',
            page: 1,
            legalBasis: [],
            suggestion: '建议增加"如为授权代表签字，需同时提供授权委托书"的说明。',
            confidence: 0.78,
            status: 'pending_review'
        }
    ],

    // 初始化
    init() {
        this.bindEvents();
        this.renderRisks();
    },

    // 绑定事件
    bindEvents() {
        // 导航菜单切换
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const view = e.currentTarget.dataset.view;
                this.switchView(view);
            });
        });

        // 点击模态框背景关闭
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('active');
                }
            });
        });

        // ESC 关闭模态框
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal').forEach(modal => {
                    modal.classList.remove('active');
                });
            }
        });
    },

    // 切换视图
    switchView(viewName) {
        // 更新导航
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.view === viewName) {
                item.classList.add('active');
            }
        });

        // 更新视图
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });

        const viewMap = {
            'home': 'homeView',
            'projects': 'projectsView',
            'workspace': 'workspaceView',
            'knowledge': 'knowledgeView',
            'skills': 'skillsView',
            'models': 'modelsView',
            'audit': 'auditView',
            'settings': 'settingsView'
        };

        const viewId = viewMap[viewName];
        if (viewId) {
            document.getElementById(viewId).classList.add('active');
        }

        // 更新面包屑
        const breadcrumbMap = {
            'home': '首页',
            'projects': '项目列表',
            'workspace': '审查工作台',
            'knowledge': '知识库管理',
            'skills': 'Skill 管理',
            'models': '模型配置',
            'audit': '审计日志',
            'settings': '系统设置'
        };
        document.getElementById('breadcrumbText').textContent = breadcrumbMap[viewName] || '首页';

        this.currentView = viewName;
    },

    // 打开审查工作台
    openWorkspace(taskId) {
        this.currentTaskId = taskId;
        this.switchView('workspace');
        this.renderRisks();

        // 显示通知
        this.showNotification('已打开审查工作台', 'info');
    },

    // 渲染风险清单
    renderRisks() {
        const riskList = document.getElementById('riskList');
        if (!riskList) return;

        const levelColors = {
            'critical': 'critical',
            'high': 'high',
            'medium': 'medium',
            'low': 'low'
        };

        const levelText = {
            'critical': '严重',
            'high': '高',
            'medium': '中',
            'low': '低'
        };

        riskList.innerHTML = this.risks.map(risk => `
            <div class="risk-card" data-risk-id="${risk.id}" onclick="app.showRiskDetail('${risk.id}')">
                <div class="risk-header">
                    <div class="risk-title">${risk.title}</div>
                    <span class="badge ${levelColors[risk.level]}">${levelText[risk.level]}</span>
                </div>
                <div class="risk-content">
                    ${risk.description.substring(0, 80)}${risk.description.length > 80 ? '...' : ''}
                </div>
                <div class="risk-footer">
                    <span>📍 ${risk.location}</span>
                    <div class="risk-actions">
                        <button class="action-btn" onclick="event.stopPropagation(); app.acceptRisk('${risk.id}')">
                            ✓ 接受
                        </button>
                        <button class="action-btn" onclick="event.stopPropagation(); app.rejectRisk('${risk.id}')">
                            ✗ 驳回
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    },

    // 显示风险详情
    showRiskDetail(riskId) {
        const risk = this.risks.find(r => r.id === riskId);
        if (!risk) return;

        const levelText = {
            'critical': '严重',
            'high': '高',
            'medium': '中',
            'low': '低'
        };

        const categoryText = {
            'legal': '法律风险',
            'commercial': '商业风险',
            'company_policy': '企业制度',
            'text_quality': '文本质量',
            'evidence': '证据问题'
        };

        const modal = document.getElementById('riskDetailModal');
        const title = document.getElementById('riskDetailTitle');
        const body = document.getElementById('riskDetailBody');

        title.textContent = risk.title;

        let legalBasisHtml = '';
        if (risk.legalBasis && risk.legalBasis.length > 0) {
            legalBasisHtml = '<h4 style="margin-top: 20px; margin-bottom: 10px;">📖 法律依据</h4>';
            risk.legalBasis.forEach(basis => {
                legalBasisHtml += `
                    <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">${basis.title} ${basis.article}</div>
                        <div style="font-size: 13px; color: var(--text-secondary);">${basis.content}</div>
                    </div>
                `;
            });
        }

        body.innerHTML = `
            <div style="margin-bottom: 16px;">
                <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                    <span class="badge ${risk.level}">${levelText[risk.level]}</span>
                    <span class="badge" style="background: #f0f0f0; color: var(--text-primary);">
                        ${categoryText[risk.category]}
                    </span>
                </div>
                <div style="color: var(--text-secondary); margin-bottom: 8px;">
                    📍 位置：${risk.location} | 第 ${risk.page} 页
                </div>
                <div style="color: var(--text-secondary); margin-bottom: 8px;">
                    🎯 置信度：${(risk.confidence * 100).toFixed(0)}%
                </div>
            </div>

            <h4 style="margin-bottom: 10px;">⚠️ 风险说明</h4>
            <div style="background: #fff9e6; padding: 12px; border-left: 3px solid var(--warning); border-radius: 4px; margin-bottom: 16px;">
                ${risk.description}
            </div>

            ${legalBasisHtml}

            <h4 style="margin-top: 20px; margin-bottom: 10px;">💡 修改建议</h4>
            <div style="background: #e6f7ff; padding: 12px; border-left: 3px solid var(--primary); border-radius: 4px;">
                ${risk.suggestion}
            </div>

            <h4 style="margin-top: 20px; margin-bottom: 10px;">📋 处理记录</h4>
            <div style="font-size: 13px; color: var(--text-secondary);">
                <div>创建人：contract-review-agent</div>
                <div>创建时间：2026-09-10 09:35:22</div>
                <div>处理状态：待人工复核</div>
            </div>
        `;

        modal.classList.add('active');
        this.selectedRiskId = riskId;

        // 高亮对应的合同文本
        this.highlightRiskInDocument(riskId);
    },

    closeRiskDetailModal() {
        document.getElementById('riskDetailModal').classList.remove('active');
        this.selectedRiskId = null;
    },

    // 在文档中高亮风险
    highlightRiskInDocument(riskId) {
        // 移除所有现有的 active 类
        document.querySelectorAll('.risk-card').forEach(card => {
            card.classList.remove('active');
        });

        // 添加 active 类到当前选中的风险卡片
        const card = document.querySelector(`[data-risk-id="${riskId}"]`);
        if (card) {
            card.classList.add('active');
        }
    },

    // 接受风险
    acceptRisk(riskId) {
        const risk = this.risks.find(r => r.id === riskId);
        if (risk) {
            risk.status = 'accepted';
            this.showNotification(`已接受风险：${risk.title}`, 'success');
            this.renderRisks();
        }
    },

    // 驳回风险
    rejectRisk(riskId) {
        const risk = this.risks.find(r => r.id === riskId);
        if (risk) {
            risk.status = 'rejected';
            this.showNotification(`已驳回风险：${risk.title}`, 'info');
            this.renderRisks();
        }
    },

    // 选区审查
    selectText() {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();

        if (selectedText) {
            this.showNotification(`正在审查选中内容（${selectedText.length}字）...`, 'info');

            // 模拟审查过程
            setTimeout(() => {
                this.showNotification('选区审查完成，已添加到风险清单', 'success');
            }, 2000);
        } else {
            this.showNotification('请先选择要审查的文本', 'warning');
        }
    },

    // 添加批注
    addAnnotation() {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();

        if (selectedText) {
            const annotation = prompt('请输入批注内容：');
            if (annotation) {
                this.showNotification('批注已添加', 'success');
            }
        } else {
            this.showNotification('请先选择要批注的文本', 'warning');
        }
    },

    // 滚动到指定章节
    scrollToSection(sectionId) {
        // 更新目录项激活状态
        document.querySelectorAll('.outline-item').forEach((item, index) => {
            item.classList.remove('active');
            if (index + 1 === sectionId) {
                item.classList.add('active');
            }
        });

        // 滚动到对应位置（简化实现）
        const documentView = document.getElementById('documentView');
        if (documentView) {
            documentView.scrollTop = sectionId * 100;
        }

        this.showNotification(`已跳转到第${sectionId}条`, 'info');
    },

    // 显示上传模态框
    showUploadModal() {
        document.getElementById('uploadModal').classList.add('active');
    },

    closeUploadModal() {
        document.getElementById('uploadModal').classList.remove('active');
    },

    // 上传合同
    uploadContract() {
        this.showNotification('正在上传合同并启动审查...', 'info');

        setTimeout(() => {
            this.closeUploadModal();
            this.showNotification('合同已上传，审查任务已创建', 'success');

            // 模拟添加新任务
            const newTask = {
                id: this.tasks.length + 1,
                title: '【新合同】示例合同',
                type: 'procurement',
                status: 'working',
                riskCount: 0,
                createdAt: new Date().toLocaleString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                }).replace(/\//g, '-')
            };
            this.tasks.unshift(newTask);
        }, 2000);
    },

    // 显示导出模态框
    showExportModal() {
        document.getElementById('exportModal').classList.add('active');
    },

    closeExportModal() {
        document.getElementById('exportModal').classList.remove('active');
    },

    // 导出报告
    exportReport() {
        this.showNotification('正在生成审查报告...', 'info');

        setTimeout(() => {
            this.closeExportModal();
            this.showNotification('审查报告已生成并下载', 'success');
        }, 1500);
    },

    // 显示通知
    showNotification(message, type = 'info') {
        // 创建通知元素
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 80px;
            right: 24px;
            background: white;
            padding: 16px 20px;
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 2000;
            display: flex;
            align-items: center;
            gap: 12px;
            min-width: 300px;
            animation: slideIn 0.3s ease-out;
        `;

        const iconMap = {
            'info': 'ℹ️',
            'success': '✅',
            'warning': '⚠️',
            'error': '❌'
        };

        const colorMap = {
            'info': '#1890ff',
            'success': '#52c41a',
            'warning': '#faad14',
            'error': '#f5222d'
        };

        notification.innerHTML = `
            <span style="font-size: 20px;">${iconMap[type] || iconMap.info}</span>
            <span style="flex: 1; color: ${colorMap[type] || colorMap.info};">${message}</span>
        `;

        // 添加关闭按钮
        const closeBtn = document.createElement('span');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = `
            cursor: pointer;
            font-size: 20px;
            color: var(--text-disabled);
        `;
        closeBtn.onclick = () => notification.remove();
        notification.appendChild(closeBtn);

        // 添加动画
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from {
                    transform: translateX(400px);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(style);

        document.body.appendChild(notification);

        // 3秒后自动移除
        setTimeout(() => {
            notification.style.animation = 'slideIn 0.3s ease-out reverse';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    app.init();
});
