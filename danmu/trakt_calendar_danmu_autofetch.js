/*

根据Trakt日历更新剧集自动下载弹幕脚本

需要在Surge模块/Loon插件中配置以下参数：
traktClientId, traktClientSecret, traktAccessToken, traktRefreshToken, danmuBaseUrl, danmuApiKey

作者：@QiXiuYuano （https://github.com/QiXiuYuano/Scripts）

脚本功能：
1. 自动从 Trakt.tv 获取用户日历中当日更新的剧集信息
2. 调用自建弹幕 API 下载对应剧集弹幕
3. 支持在 Surge、Loon 等代理工具环境中运行
4. Cron 类型脚本，可按需求设定每日/每周定时执行

-----------申请 Trakt 应用 API --------------
1. 访问 Trakt.tv 开发者页面创建应用：https://trakt.tv/oauth/applications
2. 获取 Client ID 与 Client Secret
3. 使用 OAuth 获取 Access Token 与 Refresh Token

-----------配置弹幕服务--------------
1. 自建弹幕服务，项目地址：https://github.com/l429609201/misaka_danmu_server
2. 配置弹幕 API 基础 URL 和密钥（danmuBaseUrl, danmuApiKey）

-----------软件配置（文本模式填入下方内容）--------------

1. Surge:
[Script]
Danmu-AutoFetch-TraktCalendar = type=cron, cron-exp="0 18 * * *", script-path=https://raw.githubusercontent.com/QiXiuYuano/Scripts/main/danmu/trakt_calendar_danmu_autofetch.js, script-update-interval=86400

2. Loon:
[Script]
cron "0 18 * * *" script-path=https://raw.githubusercontent.com/QiXiuYuano/Scripts/main/danmu/trakt_calendar_danmu_autofetch.js, tag=Danmu-AutoFetch-TraktCalendar, update-interval=86400

*/


const $ = new Env("Danmu-AutoFetch-TraktCalendar");

const scriptStartTime = Date.now();
let today = new Date().toISOString().split("T")[0];

let accessToken = "";
let refreshToken = "";

// ============ 脚本参数配置、验证 ============
function getArgs() {
    // 只从 Surge / Loon argument 读取初始配置，BoxJs 不再使用
    let envArgs = {};

    if (typeof $ !== "undefined" && typeof $.isLoon === "function" && $.isLoon()) {
        $.log("🔍 检测到 Loon 环境");
        if (typeof $argument === 'object' && $argument !== null) {
            envArgs = $argument;
        }
    } else if (typeof $ !== "undefined" && typeof $.isSurge === "function" && $.isSurge()) {
        $.log("🔍 检测到 Surge 环境");
        if (typeof $argument === "string" && $argument.trim()) {
            $argument.split("&").forEach(item => {
                const [k, v] = item.split("=");
                if (k && v) envArgs[k] = v;
            });
        }
    }

    return envArgs; // environment args 作为首次运行配置
}

// ============ Token 获取和验证 ============
function initializeTokens() {
    // 优先从持久化存储读取 token
    let accessToken = $.getdata("trakt_access_token") || "";
    let refreshToken = $.getdata("trakt_refresh_token") || "";

    // 如果持久化没有，再用首次运行的 argument
    if (!accessToken) accessToken = args.traktAccessToken || "";
    if (!refreshToken) refreshToken = args.traktRefreshToken || "";

    $.log(`🔑 Token状态 - traktAccessToken: ${accessToken ? '✅' : '❌'}, traktRefreshToken: ${refreshToken ? '✅' : '❌'}`);

    return { accessToken, refreshToken };
}

// 验证参数配置
function validateConfiguration() {
    const requiredFields = [
        'danmuBaseUrl',
        'danmuApiKey',
        'traktClientId',
        'traktClientSecret',
        'traktAccessToken',
        'traktRefreshToken'
    ];

    // 检查必需字段
    const missingFields = requiredFields.filter(field => !args[field]);

    if (missingFields.length > 0) {
        $.log(`❌ 配置验证失败，缺少: ${missingFields.join(', ')}`);
        return false;
    }

    // 验证Trakt.tv配置
    if (args.traktClientId.length < 10) {
        $.log(`❌ Trakt Client ID 无效`);
        return false;
    }
    if (args.traktClientSecret.length < 10) {
        $.log(`❌ Trakt Client Secret 无效`);
        return false;
    }
    // 验证弹幕API配置
    if (!args.danmuBaseUrl.startsWith('http')) {
        $.log(`❌ 弹幕API基础地址无效`);
        return false;
    }
    if (args.danmuApiKey.length < 10) {
        $.log(`❌ 弹幕API密钥无效`);
        return false;
    }
    $.log(`✅ 参数配置验证通过!`);
    return true;
}

// Token保存函数
function saveTokens(newAccessToken, newRefreshToken) {
    if (!newAccessToken || !newRefreshToken) {
        $.log(`❌ Token保存失败：Token不能为空`);
        return false;
    }

    // 保存到持久化存储
    const saveSuccess = $.setdata(newAccessToken, "trakt_access_token") &&
        $.setdata(newRefreshToken, "trakt_refresh_token");

    if (saveSuccess) {
        accessToken = newAccessToken;
        refreshToken = newRefreshToken;
        $.log(`✅ Token保存成功: access=${newAccessToken.slice(0, 6)}..., refresh=${newRefreshToken.slice(0, 6)}...`);
    } else {
        $.log(`❌ Token保存失败`);
        return false;
    }

    return true;
}

// ============ 初始化配置参数 ============
const args = getArgs();
const tokenResult = initializeTokens();
accessToken = tokenResult.accessToken;
refreshToken = tokenResult.refreshToken;

if (!validateConfiguration()) {
    $.done({ error: "Configuration validation failed" });
}

// ============ Trakt API 相关函数 ============
// 获取 Trakt 日历剧集信息
async function getTraktCalendar(queryDate = today) {
    $.log(`📅 开始获取Trakt日历数据，日期: ${queryDate}`);

    const config = {
        maxRetries: 2,
        retryDelay: 1000
    };

    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
        try {
            const shows = await requestTraktCalendar(queryDate);
            return shows;

        } catch (error) {
            const isLastAttempt = attempt > config.maxRetries;

            if (error.needsTokenRefresh && !isLastAttempt) {
                $.log(`⚠️ 认证失败，正在刷新Token... (第${attempt}次尝试)`);

                try {
                    await refreshTraktToken();
                    $.log(`✅ Token刷新成功，准备重试`);
                    await new Promise(resolve => setTimeout(resolve, config.retryDelay));
                    continue;
                } catch (refreshError) {
                    $.log(`❌ Token刷新失败: ${refreshError.message}`);
                    throw new Error(`认证失败: ${refreshError.message}`);
                }
            }

            if (isLastAttempt) {
                $.log(`❌ 获取日历最终失败: ${error.message}`);
                throw error;
            }

            $.log(`⚠️ 第${attempt}次尝试失败: ${error.message}, 准备重试...`);
            await new Promise(resolve => setTimeout(resolve, config.retryDelay));
        }
    }
}

// 发起获取 Trakt 日历剧集数据请求
function requestTraktCalendar(date) {
    return new Promise((resolve, reject) => {
        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
            "trakt-api-version": "2",
            "trakt-api-key": args.traktClientId,
        };

        const requestUrl = `https://api.trakt.tv/calendars/my/shows/${date}/1?extended=full`;

        $.get({ url: requestUrl, headers }, (err, resp, data) => {
            if (err) {
                $.log(`❌ 网络连接失败: ${err.code || err.message}`);
                return reject(new Error(`网络连接失败: ${err.code || err.message}`));
            }

            const status = resp?.status || 'unknown';

            // 使用 Map 进行错误映射
            const errorMap = new Map([
                [401, { message: '认证失败，访问令牌已过期', needsTokenRefresh: true }],
                [403, { message: '访问被拒绝，权限不足', needsTokenRefresh: true }],
                [429, { message: 'API请求频率限制', needsTokenRefresh: false }],
                [500, { message: 'Trakt服务器内部错误', needsTokenRefresh: false }]
            ]);

            if (status !== 200 && errorMap.has(status)) {
                const errorInfo = errorMap.get(status);
                $.log(`❌ API错误: ${errorInfo.message}`);
                const error = new Error(errorInfo.message);
                error.needsTokenRefresh = errorInfo.needsTokenRefresh;
                error.status = status;
                return reject(error);
            }

            if (status !== 200) {
                $.log(`❌ HTTP错误: ${status}`);
                return reject(new Error(`HTTP错误: ${status}`));
            }

            if (!data?.trim()) {
                $.log(`ℹ️ 今日无更新剧集`);
                return resolve([]);
            }

            try {
                const shows = JSON.parse(data);
                if (!Array.isArray(shows)) {
                    throw new Error('响应数据格式错误，期望数组格式');
                }
                resolve(shows);
            } catch (parseError) {
                $.log(`❌ JSON解析失败: ${parseError.message}`);
                reject(new Error(`数据解析失败: ${parseError.message}`));
            }
        });
    });
};

// 刷新 Trakt Token
const refreshTraktToken = () => {
    return new Promise((resolve, reject) => {
        $.log(`🔄 开始刷新Trakt访问令牌`);

        const requestBody = {
            refresh_token: refreshToken,
            client_id: args.traktClientId,
            client_secret: args.traktClientSecret,
            redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
            grant_type: "refresh_token",
        };

        const headers = {
            "Content-Type": "application/json",
        };

        $.post({
            url: "https://api.trakt.tv/oauth/token",
            headers,
            body: JSON.stringify(requestBody),
        }, (err, resp, data) => {
            if (err) {
                $.log(`❌ Token刷新请求错误: ${err.message}`);
                return reject(err);
            }

            const status = resp?.status;
            $.log(`📡 Token刷新响应状态: ${status}`);

            if (status !== 200) {
                $.log(`❌ Token刷新失败，状态码: ${status}`);
                return reject(new Error(`Token refresh failed with status ${status}`));
            }

            if (!data) {
                $.log(`❌ Token刷新无响应数据`);
                return reject(new Error("No response data from token refresh"));
            }

            try {
                const res = JSON.parse(data);
                const { access_token, refresh_token, expires_in } = res;

                if (!access_token || !refresh_token) {
                    $.log(`❌ Token刷新响应数据缺少必要字段`);
                    return reject(new Error("Invalid token response: missing tokens"));
                }

                // 更新全局令牌
                accessToken = access_token;
                refreshToken = refresh_token;

                // 保存Token
                saveTokens(access_token, refresh_token);

                $.log(`✅ Trakt Token刷新成功`);
                if (expires_in) {
                    $.log(`⏰ Token有效期: ${expires_in}秒`);
                }

                resolve();
            } catch (e) {
                $.log(`❌ Token刷新数据解析错误: ${e.message}`);
                reject(e);
            }
        });
    });
};


// ============ 调用弹幕API自动导入接口 ============
function callDanmuAutoImport(searchType, searchTerm, season, episode) {
    return new Promise((resolve, reject) => {
        // 构建请求参数
        const params = new URLSearchParams({
            api_key: args.danmuApiKey,
            searchType: searchType,
            searchTerm: searchTerm,
            season: season,
            episode: episode
        });

        if (searchType === 'keyword') {
            params.append('mediaType', 'tv_series');
        }

        const url = `${args.danmuBaseUrl}/api/control/import/auto?${params.toString()}`;

        $.post(
            {
                url: url,
                headers: { "Content-Type": "application/json" },
                body: ""
            },
            (err, resp, data) => {
                if (err) {
                    $.log(`❌ 弹幕导入网络错误: ${err.message || err}`);
                    return reject(new Error(`网络请求失败: ${err.message || err}`));
                }

                const status = resp?.status || 'unknown';

                if (status === 202) {
                    const result = JSON.parse(data);
                    $.log(`✅ 外部API${result.message}, ID: ${result.taskId}`);
                    resolve(result);
                } else if (status === 422) {
                    $.log(`❌ 参数验证失败: ${data}`);
                    reject(new Error(`参数验证失败: ${data}`));
                } else if (status === 401 || status === 403) {
                    $.log(`❌ API认证失败，请检查API密钥`);
                    reject(new Error('API认证失败，请检查API密钥'));
                } else {
                    $.log(`❌ 弹幕导入失败，状态码: ${status}, 响应: ${data}`);
                    reject(new Error(`HTTP ${status}: ${data || '未知错误'}`));
                }
            }
        );
    });
}

// 获取任务状态
function getTaskStatus(taskId) {
    return new Promise((resolve, reject) => {
        const url = `${args.danmuBaseUrl}/api/control/tasks/${taskId}?api_key=${args.danmuApiKey}`;
        $.get(
            {
                url: url,
                headers: {}
            },
            (err, resp, data) => {
                if (err) {
                    $.log(`[任务状态] ${taskId} 请求错误: ${err}`);
                    return reject(err);
                }

                const status = resp?.status || 'unknown';

                if (status === 200) {
                    try {
                        const result = JSON.parse(data);
                        resolve(result);
                    } catch (e) {
                        $.log(`[任务状态] ${taskId} 数据解析错误: ${e.message}`);
                        reject(new Error(`数据解析失败: ${e.message}`));
                    }
                } else if (status === 404) {
                    $.log(`[任务状态] ${taskId} 任务不存在: ${taskId}`);
                    reject(new Error(`任务不存在: ${taskId}`));
                } else if (status === 401 || status === 403) {
                    $.log(`[任务状态] API认证失败`);
                    reject(new Error('API认证失败，请检查API密钥'));
                } else {
                    $.log(`[任务状态] HTTP错误: ${status}, 响应: ${data}`);
                    reject(new Error(`HTTP ${status}: ${data || '未知错误'}`));
                }
            }
        );
    });
}


// 等待任务完成并监控状态
async function waitForTaskCompletion(taskId) {

    let attempts = 0;
    const maxAttempts = 120; // 最多等待10分钟 (每5秒检查一次)
    let taskStarted = false; // 标记任务是否已开始执行

    while (attempts < maxAttempts) {
        try {
            const taskInfo = await getTaskStatus(taskId);
            if (!taskStarted) {
                $.log(`[任务监控] 任务 '${taskInfo.title}' 已提交, ID: (${taskId})`);
                $.log(`[任务监控] 开始执行任务 '${taskInfo.title}' (ID: ${taskId})`);
                taskStarted = true;
            }

            $.log(`[任务监控] ${taskInfo.title} - 状态: ${taskInfo.status}, 进度: ${taskInfo.progress}%`);

            if (taskInfo.status === 'COMPLETED' || taskInfo.status === '已完成') {
                $.log(`[任务监控] ${taskInfo.title} - 弹幕下载任务完成!`);
                return taskInfo;
            } else if (taskInfo.status === 'FAILED' || taskInfo.status === '失败') {
                $.log(`[任务监控] ${taskInfo.title} - 任务失败: ${taskInfo.description}`);
                return null;
            }

            // 等待5秒后再次检查
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        } catch (error) {
            $.log(`[任务监控] ${taskId} - 任务失败: ${error.message}`);
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    $.log(`[任务监控] ${taskId} - 超时，停止监控`);
    return null;
}

// 获取调度任务的执行任务ID（单次请求）
function getExecutionTaskId(schedulerTaskId) {
    return new Promise((resolve, reject) => {
        const url = `${args.danmuBaseUrl}/api/control/tasks/${schedulerTaskId}/execution?api_key=${args.danmuApiKey}`;

        $.get(
            {
                url: url,
                headers: {}
            },
            (err, resp, data) => {
                if (err) {
                    $.log(`[执行任务查询] ${schedulerTaskId} 请求错误: ${err}`);
                    return reject(err);
                }

                const status = resp?.status || 'unknown';

                if (status === 200) {
                    try {
                        const result = JSON.parse(data);
                        resolve(result.executionTaskId); // 直接返回executionTaskId，可能为null
                    } catch (e) {
                        $.log(`[执行任务查询] ${schedulerTaskId} 数据解析错误: ${e.message}`);
                        reject(new Error(`数据解析失败: ${e.message}`));
                    }
                } else if (status === 422) {
                    $.log(`[执行任务查询] ${schedulerTaskId} 参数验证失败: ${data}`);
                    reject(new Error(`参数验证失败: ${data}`));
                } else if (status === 401 || status === 403) {
                    $.log(`[执行任务查询] API认证失败`);
                    reject(new Error('API认证失败，请检查API密钥'));
                } else {
                    $.log(`[执行任务查询] HTTP错误: ${status}, 响应: ${data}`);
                    reject(new Error(`HTTP ${status}: ${data || '未知错误'}`));
                }
            }
        );
    });
}

// 轮询获取执行任务ID，直到获取到有效ID
async function findExecutionTaskId(schedulerTaskId, maxRetries = 10, retryDelay = 5000) {
    $.log(`🔍 开始轮询调度任务 ${schedulerTaskId} 的执行任务ID`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            $.log(`🔍 第${attempt}次尝试获取执行任务ID...`);

            const executionTaskId = await getExecutionTaskId(schedulerTaskId);

            // 检查是否获取到有效的执行任务ID
            if (!executionTaskId) {
                if (attempt === maxRetries) {
                    $.log(`❌ 调度任务 ${schedulerTaskId} 在${maxRetries}次尝试后仍未生成有效的执行任务ID`);
                    return null;
                } else {
                    $.log(`⚠️ 调度任务 ${schedulerTaskId} 暂未触发执行任务，${retryDelay / 1000}秒后重试...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }
            }

            // 找到有效的执行任务ID
            $.log(`✅ 调度任务 ${schedulerTaskId} 已触发执行任务: ${executionTaskId}`);
            return executionTaskId;

        } catch (error) {
            if (attempt === maxRetries) {
                $.log(`❌ 获取执行任务ID最终失败: ${error.message}`);
                return null;
            } else {
                $.log(`⚠️ 第${attempt}次尝试失败: ${error.message}，${retryDelay / 1000}秒后重试...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }

    return null;
}


// ============ 剧集数据解析和增强 ============
// 添加TMDB处理非中文剧集信息。
function parseEpisodeData(show) {
    const episodeData = {
        // 基础信息
        showTitle: show.show.original_title,
        season: show.episode.season,
        episode: show.episode.number,
        episodeTitle: show.episode.original_title,
        airDate: show.first_aired,

        // 外部ID信息
        ids: {
            trakt: show.show.ids?.trakt,
            tmdb: show.show.ids?.tmdb,
            imdb: show.show.ids?.imdb,
            tvdb: show.show.ids?.tvdb
        },

        // 搜索策略
        searchTerm: null,
        searchType: null
    };

    // 确定搜索策略
    if (episodeData.ids.tmdb) {
        episodeData.searchType = 'tmdb';
        episodeData.searchTerm = episodeData.ids.tmdb;
    } else if (episodeData.ids.imdb) {
        episodeData.searchType = 'imdb';
        episodeData.searchTerm = episodeData.ids.imdb;
    } else if (episodeData.ids.tvdb) {
        episodeData.searchType = 'tvdb';
        episodeData.searchTerm = episodeData.ids.tvdb;
    } else {
        episodeData.searchType = 'keyword';
        episodeData.searchTerm = episodeData.showTitle;
    }

    return episodeData;
}

// ============ 处理单个剧集的完整流程 ============
async function processEpisode(show) {
    const episodeData = parseEpisodeData(show);
    const episodeInfo = `${episodeData.showTitle} - S${episodeData.season}E${episodeData.episode} (${episodeData.episodeTitle})`;
    $.log(`🎬 开始下载弹幕: ${episodeInfo}`);

    try {
        // 步骤1: 调用自动导入API
        const schedulerTaskResponse = await callDanmuAutoImport(
            episodeData.searchType,
            episodeData.searchTerm,
            episodeData.season,
            episodeData.episode
        );

        // 步骤2: 查找执行任务ID
        const executionTaskId = await findExecutionTaskId(schedulerTaskResponse.taskId);
        if (!executionTaskId) {
            $.log(`❌ ${episodeInfo} 未找到弹幕下载执行任务`);
            return null;
        }

        // 步骤3: 等待执行任务完成
        const executionTaskInfo = await waitForTaskCompletion(executionTaskId);
        if (!executionTaskInfo) {
            $.log(`❌ ${episodeInfo} 弹幕下载失败`);
            return null;
        } else {
            return executionTaskInfo;
        }
    } catch (error) {
        $.log(`❌ ${episodeInfo} 弹幕下载失败: ${error.message}`);
        return null;
    }
}


// ============ 主函数 ============
async function main() {
    try {
        const shows = await getTraktCalendar();
        if (!shows?.length) {
            $.log("📭 今日没有剧集更新");
            $.msg("Trakt弹幕下载", "今日没有剧集更新");
            $.done();
            return;
        }

        $.log(`📺 今日共有 ${shows.length} 个剧集更新:`);
        shows.forEach((s, index) => {
            $.log(`   ${index + 1}. ${s.show.original_title} - S${s.episode.season}E${s.episode.number} (${s.episode.original_title})`);
        });

        $.log("🎯 开始自动下载弹幕...");
        let successCount = 0;
        let failCount = 0;
        let skipCount = 0; // 新增跳过计数器

        // 用于存储通知信息的数组
        const notificationMessages = [];

        for (let i = 0; i < shows.length; i++) {
            const show = shows[i];

            const airTime = new Date(show.first_aired);
            const currentTime = new Date();

            // 如果脚本执行时尚未到剧集播放时间，则跳过该集
            if (currentTime < airTime) {
                const showInfo = `${show.show.original_title} - S${show.episode.season}E${show.episode.number} (${show.episode.original_title})`;
                $.log(`⏩ ${showInfo} 尚未到播放时间 (${show.first_aired})，跳过下载任务`);
                notificationMessages.push(`⏩ ${showInfo} - 未到播放时间，已跳过`);
                skipCount++;
                continue;
            }

            const showInfo = `${show.show.original_title} - S${show.episode.season}E${show.episode.number} (${show.episode.original_title})`;
            // $.log(`📍 今日更新剧集弹幕下载进度: ${i + 1}/${shows.length}`);
            $.log(`📍 今日更新剧集弹幕下载进度: ${i + 1 - skipCount}/${shows.length - skipCount}`);

            try {
                const taskInfo = await processEpisode(show);
                if (taskInfo) {
                    successCount++;
                    $.log(`🎉 任务: ${taskInfo.title} 完成`, `🔔 消息: ${taskInfo.description}`);
                    // $.msg(`🔔 ${showInfo} 已更新!`, `🎉 弹幕${taskInfo.description}`);
                    notificationMessages.push(`✅ ${showInfo} - 弹幕${taskInfo.description}`);
                } else {
                    failCount++;
                    // 单个剧集下载失败立即通知
                    $.log(`❌ ${showInfo} 弹幕下载失败`);
                    // $.msg(`❌ ${showInfo}`, `弹幕下载失败`);
                    notificationMessages.push(`❌ ${showInfo} - 弹幕下载失败`);
                }
            } catch (error) {
                failCount++;
                // 单个剧集处理出错立即通知
                $.log(`❌ 处理剧集失败: ${error.message}`);
                // $.msg(`❌ ${showInfo}`, `处理过程中出错`, error.message);
                notificationMessages.push(`❌ ${showInfo} - 处理过程中出错: ${error.message}`);
            }

            // 在处理下一个剧集前等待一段时间，避免API频率限制
            if (i < shows.length - 1) {
                $.log("⏳ 等待2秒后处理下一个剧集...");
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // 生成统计报告
        const report = {
            success: successCount,
            failed: failCount,
            skipped: skipCount, // 新增跳过统计
            total: shows.length,
            successRate: shows.length > skipCount ? ((successCount / (shows.length - skipCount)) * 100).toFixed(1) : "0.0"
        };

        const scriptDuration = ((Date.now() - scriptStartTime) / 1000).toFixed(1); // 总执行时间（秒）
        $.log(`\n📊 处理完成统计:`);
        $.log(`   ✅ 成功: ${report.success} 个`);
        $.log(`   ❌ 失败: ${report.failed} 个`);
        $.log(`   ⏩ 跳过: ${report.skipped} 个`);
        $.log(`   📈 总计: ${report.total} 个`);
        $.log(`   📊 成功率: ${report.successRate}%`);
        $.log(`   🕐 总耗时: ${scriptDuration} 分钟`);

        // 发送剧集下载结果的汇总通知
        const title = "Trakt日历剧集弹幕下载结果";
        if (notificationMessages.length > 0) {
            const summary = `✅ 成功: ${successCount}  ❌ 失败: ${failCount}  ⏩ 跳过: ${skipCount}`;
            // 将耗时信息添加到通知正文末尾
            const body = "\n" + notificationMessages.join("\n") + `\n\n🕐 总耗时: ${scriptDuration} 秒`;
            $.msg(title, summary, body);
        } else {
            // 没有剧集需要处理的情况  
            const summary = "ℹ️ 无下载任务";
            const body = `今日没有需要处理的剧集\n\n🕐 总耗时: ${scriptDuration} 分钟`;
            $.msg(title, summary, body);
        }

        $.done();

    } catch (e) {
        const scriptDuration = ((Date.now() - scriptStartTime) / 1000).toFixed(1);
        $.log("❌ 脚本出错:", e);
        $.log(`🕐 脚本执行时间: ${scriptDuration} 秒`);
        $.msg("Trakt日历更新剧集弹幕下载", "脚本执行出错", e.message);
        $.done();
    }
}

main();

/** ---------------Env.js工具函数--------------- */
function Env(e, t) { class s { constructor(e) { this.env = e } send(e, t = "GET") { e = "string" == typeof e ? { url: e } : e; let s = this.get; "POST" === t && (s = this.post); const i = new Promise(((t, i) => { s.call(this, e, ((e, s, o) => { e ? i(e) : t(s) })) })); return e.timeout ? ((e, t = 1e3) => Promise.race([e, new Promise(((e, s) => { setTimeout((() => { s(new Error("请求超时")) }), t) }))]))(i, e.timeout) : i } get(e) { return this.send.call(this.env, e) } post(e) { return this.send.call(this.env, e, "POST") } } return new class { constructor(e, t) { this.logLevels = { debug: 0, info: 1, warn: 2, error: 3 }, this.logLevelPrefixs = { debug: "[DEBUG] ", info: "[INFO] ", warn: "[WARN] ", error: "[ERROR] " }, this.logLevel = "info", this.name = e, this.http = new s(this), this.data = null, this.dataFile = "box.dat", this.logs = [], this.isMute = !1, this.isNeedRewrite = !1, this.logSeparator = "\n", this.encoding = "utf-8", this.startTime = (new Date).getTime(), Object.assign(this, t), this.log("", `🔔${this.name}, 开始!`) } getEnv() { return "undefined" != typeof $environment && $environment["surge-version"] ? "Surge" : "undefined" != typeof $environment && $environment["stash-version"] ? "Stash" : "undefined" != typeof module && module.exports ? "Node.js" : "undefined" != typeof $task ? "Quantumult X" : "undefined" != typeof $loon ? "Loon" : "undefined" != typeof $rocket ? "Shadowrocket" : void 0 } isNode() { return "Node.js" === this.getEnv() } isQuanX() { return "Quantumult X" === this.getEnv() } isSurge() { return "Surge" === this.getEnv() } isLoon() { return "Loon" === this.getEnv() } isShadowrocket() { return "Shadowrocket" === this.getEnv() } isStash() { return "Stash" === this.getEnv() } toObj(e, t = null) { try { return JSON.parse(e) } catch { return t } } toStr(e, t = null, ...s) { try { return JSON.stringify(e, ...s) } catch { return t } } getjson(e, t) { let s = t; if (this.getdata(e)) try { s = JSON.parse(this.getdata(e)) } catch { } return s } setjson(e, t) { try { return this.setdata(JSON.stringify(e), t) } catch { return !1 } } getScript(e) { return new Promise((t => { this.get({ url: e }, ((e, s, i) => t(i))) })) } runScript(e, t) { return new Promise((s => { let i = this.getdata("@chavy_boxjs_userCfgs.httpapi"); i = i ? i.replace(/\n/g, "").trim() : i; let o = this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout"); o = o ? 1 * o : 20, o = t && t.timeout ? t.timeout : o; const [r, a] = i.split("@"), n = { url: `http://${a}/v1/scripting/evaluate`, body: { script_text: e, mock_type: "cron", timeout: o }, headers: { "X-Key": r, Accept: "*/*" }, policy: "DIRECT", timeout: o }; this.post(n, ((e, t, i) => s(i))) })).catch((e => this.logErr(e))) } loaddata() { if (!this.isNode()) return {}; { this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path"); const e = this.path.resolve(this.dataFile), t = this.path.resolve(process.cwd(), this.dataFile), s = this.fs.existsSync(e), i = !s && this.fs.existsSync(t); if (!s && !i) return {}; { const i = s ? e : t; try { return JSON.parse(this.fs.readFileSync(i)) } catch (e) { return {} } } } } writedata() { if (this.isNode()) { this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path"); const e = this.path.resolve(this.dataFile), t = this.path.resolve(process.cwd(), this.dataFile), s = this.fs.existsSync(e), i = !s && this.fs.existsSync(t), o = JSON.stringify(this.data); s ? this.fs.writeFileSync(e, o) : i ? this.fs.writeFileSync(t, o) : this.fs.writeFileSync(e, o) } } lodash_get(e, t, s) { const i = t.replace(/\[(\d+)\]/g, ".$1").split("."); let o = e; for (const e of i) if (o = Object(o)[e], void 0 === o) return s; return o } lodash_set(e, t, s) { return Object(e) !== e || (Array.isArray(t) || (t = t.toString().match(/[^.[\]]+/g) || []), t.slice(0, -1).reduce(((e, s, i) => Object(e[s]) === e[s] ? e[s] : e[s] = Math.abs(t[i + 1]) >> 0 == +t[i + 1] ? [] : {}), e)[t[t.length - 1]] = s), e } getdata(e) { let t = this.getval(e); if (/^@/.test(e)) { const [, s, i] = /^@(.*?)\.(.*?)$/.exec(e), o = s ? this.getval(s) : ""; if (o) try { const e = JSON.parse(o); t = e ? this.lodash_get(e, i, "") : t } catch (e) { t = "" } } return t } setdata(e, t) { let s = !1; if (/^@/.test(t)) { const [, i, o] = /^@(.*?)\.(.*?)$/.exec(t), r = this.getval(i), a = i ? "null" === r ? null : r || "{}" : "{}"; try { const t = JSON.parse(a); this.lodash_set(t, o, e), s = this.setval(JSON.stringify(t), i) } catch (t) { const r = {}; this.lodash_set(r, o, e), s = this.setval(JSON.stringify(r), i) } } else s = this.setval(e, t); return s } getval(e) { switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": return $persistentStore.read(e); case "Quantumult X": return $prefs.valueForKey(e); case "Node.js": return this.data = this.loaddata(), this.data[e]; default: return this.data && this.data[e] || null } } setval(e, t) { switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": return $persistentStore.write(e, t); case "Quantumult X": return $prefs.setValueForKey(e, t); case "Node.js": return this.data = this.loaddata(), this.data[t] = e, this.writedata(), !0; default: return this.data && this.data[t] || null } } initGotEnv(e) { this.got = this.got ? this.got : require("got"), this.cktough = this.cktough ? this.cktough : require("tough-cookie"), this.ckjar = this.ckjar ? this.ckjar : new this.cktough.CookieJar, e && (e.headers = e.headers ? e.headers : {}, e && (e.headers = e.headers ? e.headers : {}, void 0 === e.headers.cookie && void 0 === e.headers.Cookie && void 0 === e.cookieJar && (e.cookieJar = this.ckjar))) } get(e, t = (() => { })) { switch (e.headers && (delete e.headers["Content-Type"], delete e.headers["Content-Length"], delete e.headers["content-type"], delete e.headers["content-length"]), e.params && (e.url += "?" + this.queryStr(e.params)), void 0 === e.followRedirect || e.followRedirect || ((this.isSurge() || this.isLoon()) && (e["auto-redirect"] = !1), this.isQuanX() && (e.opts ? e.opts.redirection = !1 : e.opts = { redirection: !1 })), this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": default: this.isSurge() && this.isNeedRewrite && (e.headers = e.headers || {}, Object.assign(e.headers, { "X-Surge-Skip-Scripting": !1 })), $httpClient.get(e, ((e, s, i) => { !e && s && (s.body = i, s.statusCode = s.status ? s.status : s.statusCode, s.status = s.statusCode), t(e, s, i) })); break; case "Quantumult X": this.isNeedRewrite && (e.opts = e.opts || {}, Object.assign(e.opts, { hints: !1 })), $task.fetch(e).then((e => { const { statusCode: s, statusCode: i, headers: o, body: r, bodyBytes: a } = e; t(null, { status: s, statusCode: i, headers: o, body: r, bodyBytes: a }, r, a) }), (e => t(e && e.error || "UndefinedError"))); break; case "Node.js": let s = require("iconv-lite"); this.initGotEnv(e), this.got(e).on("redirect", ((e, t) => { try { if (e.headers["set-cookie"]) { const s = e.headers["set-cookie"].map(this.cktough.Cookie.parse).toString(); s && this.ckjar.setCookieSync(s, null), t.cookieJar = this.ckjar } } catch (e) { this.logErr(e) } })).then((e => { const { statusCode: i, statusCode: o, headers: r, rawBody: a } = e, n = s.decode(a, this.encoding); t(null, { status: i, statusCode: o, headers: r, rawBody: a, body: n }, n) }), (e => { const { message: i, response: o } = e; t(i, o, o && s.decode(o.rawBody, this.encoding)) })); break } } post(e, t = (() => { })) { const s = e.method ? e.method.toLocaleLowerCase() : "post"; switch (e.body && e.headers && !e.headers["Content-Type"] && !e.headers["content-type"] && (e.headers["content-type"] = "application/x-www-form-urlencoded"), e.headers && (delete e.headers["Content-Length"], delete e.headers["content-length"]), void 0 === e.followRedirect || e.followRedirect || ((this.isSurge() || this.isLoon()) && (e["auto-redirect"] = !1), this.isQuanX() && (e.opts ? e.opts.redirection = !1 : e.opts = { redirection: !1 })), this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": default: this.isSurge() && this.isNeedRewrite && (e.headers = e.headers || {}, Object.assign(e.headers, { "X-Surge-Skip-Scripting": !1 })), $httpClient[s](e, ((e, s, i) => { !e && s && (s.body = i, s.statusCode = s.status ? s.status : s.statusCode, s.status = s.statusCode), t(e, s, i) })); break; case "Quantumult X": e.method = s, this.isNeedRewrite && (e.opts = e.opts || {}, Object.assign(e.opts, { hints: !1 })), $task.fetch(e).then((e => { const { statusCode: s, statusCode: i, headers: o, body: r, bodyBytes: a } = e; t(null, { status: s, statusCode: i, headers: o, body: r, bodyBytes: a }, r, a) }), (e => t(e && e.error || "UndefinedError"))); break; case "Node.js": let i = require("iconv-lite"); this.initGotEnv(e); const { url: o, ...r } = e; this.got[s](o, r).then((e => { const { statusCode: s, statusCode: o, headers: r, rawBody: a } = e, n = i.decode(a, this.encoding); t(null, { status: s, statusCode: o, headers: r, rawBody: a, body: n }, n) }), (e => { const { message: s, response: o } = e; t(s, o, o && i.decode(o.rawBody, this.encoding)) })); break } } time(e, t = null) { const s = t ? new Date(t) : new Date; let i = { "M+": s.getMonth() + 1, "d+": s.getDate(), "H+": s.getHours(), "m+": s.getMinutes(), "s+": s.getSeconds(), "q+": Math.floor((s.getMonth() + 3) / 3), S: s.getMilliseconds() }; /(y+)/.test(e) && (e = e.replace(RegExp.$1, (s.getFullYear() + "").substr(4 - RegExp.$1.length))); for (let t in i) new RegExp("(" + t + ")").test(e) && (e = e.replace(RegExp.$1, 1 == RegExp.$1.length ? i[t] : ("00" + i[t]).substr(("" + i[t]).length))); return e } queryStr(e) { let t = ""; for (const s in e) { let i = e[s]; null != i && "" !== i && ("object" == typeof i && (i = JSON.stringify(i)), t += `${s}=${i}&`) } return t = t.substring(0, t.length - 1), t } msg(t = e, s = "", i = "", o = {}) { const r = e => { const { $open: t, $copy: s, $media: i, $mediaMime: o } = e; switch (typeof e) { case void 0: return e; case "string": switch (this.getEnv()) { case "Surge": case "Stash": default: return { url: e }; case "Loon": case "Shadowrocket": return e; case "Quantumult X": return { "open-url": e }; case "Node.js": return }case "object": switch (this.getEnv()) { case "Surge": case "Stash": case "Shadowrocket": default: { const r = {}; let a = e.openUrl || e.url || e["open-url"] || t; a && Object.assign(r, { action: "open-url", url: a }); let n = e["update-pasteboard"] || e.updatePasteboard || s; n && Object.assign(r, { action: "clipboard", text: n }); let h = e.mediaUrl || e["media-url"] || i; if (h) { let e, t; if (h.startsWith("http")); else if (h.startsWith("data:")) { const [s] = h.split(";"), [, i] = h.split(","); e = i, t = s.replace("data:", "") } else { e = h, t = (e => { const t = { JVBERi0: "application/pdf", R0lGODdh: "image/gif", R0lGODlh: "image/gif", iVBORw0KGgo: "image/png", "/9j/": "image/jpg" }; for (var s in t) if (0 === e.indexOf(s)) return t[s]; return null })(h) } Object.assign(r, { "media-url": h, "media-base64": e, "media-base64-mime": o ?? t }) } return Object.assign(r, { "auto-dismiss": e["auto-dismiss"], sound: e.sound }), r } case "Loon": { const s = {}; let o = e.openUrl || e.url || e["open-url"] || t; o && Object.assign(s, { openUrl: o }); let r = e.mediaUrl || e["media-url"] || i; return r && Object.assign(s, { mediaUrl: r }), console.log(JSON.stringify(s)), s } case "Quantumult X": { const o = {}; let r = e["open-url"] || e.url || e.openUrl || t; r && Object.assign(o, { "open-url": r }); let a = e.mediaUrl || e["media-url"] || i; a && Object.assign(o, { "media-url": a }); let n = e["update-pasteboard"] || e.updatePasteboard || s; return n && Object.assign(o, { "update-pasteboard": n }), console.log(JSON.stringify(o)), o } case "Node.js": return }default: return } }; if (!this.isMute) switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": default: $notification.post(t, s, i, r(o)); break; case "Quantumult X": $notify(t, s, i, r(o)); break; case "Node.js": break }if (!this.isMuteLog) { let e = ["", "==============📣系统通知📣=============="]; e.push(t), s && e.push(s), i && e.push(i), console.log(e.join("\n")), this.logs = this.logs.concat(e) } } debug(...e) { this.logLevels[this.logLevel] <= this.logLevels.debug && (e.length > 0 && (this.logs = [...this.logs, ...e]), console.log(`${this.logLevelPrefixs.debug}${e.map((e => e ?? String(e))).join(this.logSeparator)}`)) } info(...e) { this.logLevels[this.logLevel] <= this.logLevels.info && (e.length > 0 && (this.logs = [...this.logs, ...e]), console.log(`${this.logLevelPrefixs.info}${e.map((e => e ?? String(e))).join(this.logSeparator)}`)) } warn(...e) { this.logLevels[this.logLevel] <= this.logLevels.warn && (e.length > 0 && (this.logs = [...this.logs, ...e]), console.log(`${this.logLevelPrefixs.warn}${e.map((e => e ?? String(e))).join(this.logSeparator)}`)) } error(...e) { this.logLevels[this.logLevel] <= this.logLevels.error && (e.length > 0 && (this.logs = [...this.logs, ...e]), console.log(`${this.logLevelPrefixs.error}${e.map((e => e ?? String(e))).join(this.logSeparator)}`)) } log(...e) { e.length > 0 && (this.logs = [...this.logs, ...e]), console.log(e.map((e => e ?? String(e))).join(this.logSeparator)) } logErr(e, t) { switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": case "Quantumult X": default: this.log("", `❗️${this.name}, 错误!`, t, e); break; case "Node.js": this.log("", `❗️${this.name}, 错误!`, t, void 0 !== e.message ? e.message : e, e.stack); break } } wait(e) { return new Promise((t => setTimeout(t, e))) } done(e = {}) { const t = ((new Date).getTime() - this.startTime) / 1e3; switch (this.log("", `🔔${this.name}, 结束! 🕛 ${t} 秒`), this.log(), this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": case "Quantumult X": default: $done(e); break; case "Node.js": process.exit(1) } } }(e, t) }


