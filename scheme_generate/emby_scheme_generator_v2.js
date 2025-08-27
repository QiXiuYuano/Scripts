/**
 * Emby 配置文本解析与 Scheme URL 生成脚本
 * 
 * 功能：
 * 1. 从输入的配置文本中提取用户名、密码及线路信息
 * 2. 生成适用于 Forward App 和 SenPlayer App 的导入 Scheme URL
 * 
 * 说明：
 * - 脚本仅在本地运行，数据不会上传
 * - 支持多条线路，自动区分主线路与备用线路
 * 
 * 作者：https://github.com/QiXiuYuano
 * 脚本地址：https://github.com/QiXiuYuano/ForwardWidgets/main/scheme/emby_scheme_generator_v2.js
 * 转载请保留来源
 */

function parseUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') {
        return null;
    }

    try {
        if (typeof URL !== 'undefined') {
            try {
                const urlObj = new URL(urlString);
                return {
                    protocol: urlObj.protocol || '',
                    hostname: urlObj.hostname || '',
                    port: urlObj.port || '',
                    pathname: urlObj.pathname || '/',
                    search: urlObj.search || '',
                    hash: urlObj.hash || '',
                    toString: () => urlString
                };
            } catch (e) {
                // 继续使用手动解析
            }
        }
        
        // 手动解析 URL（用于 Scriptable 或 URL 解析失败的情况）
        const urlPattern = /^(https?:)\/\/([^\/:]+)(?::(\d+))?(\/[^?#]*)?(\?[^#]*)?(#.*)?$/;
        const match = urlString.match(urlPattern);
        
        if (!match) {
            return null;
        }
        
        const [, protocol = '', hostname = '', port = '', pathname = '/', search = '', hash = ''] = match;
        
        return {
            protocol,
            hostname,
            port,
            pathname,
            search,
            hash,
            toString: () => urlString
        };
    } catch (e) {
        // console.error('URL parsing error:', e);
        return null;
    }
}

function parseEmbyInfo(configText) {
    const embyInfo = { username: '', password: '', lines: [] };
    const textLines = configText.split('\n');
    let lastHost = null;
    let pendingLineTitle = null; // 用于存储可能的线路标题

    const regexPatterns = {
        username: /(?:用户名|用户名称)\s*[|：:]\s*(\S.+)/u,
        password: /(?:密码|用户密码)\s*[|：:]\s*(\S+)/,
        genericUrl: /((?:[\w\d\u4e00-\u9fa5]*\s*线路\s*\d*|服务器|地址|主机名|备用|ip|cf)\s*)(?:[|：:]\s*|\s+)((https?:\/\/)?[a-zA-Z0-9.\-]+\.[a-zA-Z0-9.\-:]*)/i,
        // 识别线路标题行（包含"线路"但不包含URL）
        lineTitle: /^([\w\d\u4e00-\u9fa5]*\s*线路[\w\d\u4e00-\u9fa5]*)/u,
        // 同一行包含线路标题和URL（可能有其他文字）
        lineWithUrl: /^([\w\d\u4e00-\u9fa5]*\s*线路[\w\d\u4e00-\u9fa5]*)[\s\S]*?((https?:\/\/)?[a-zA-Z0-9.\-]+\.[a-zA-Z0-9.\-:]*)/u,
        // 匹配包含URL的任意行（用于接续上一行的线路标题）
        urlInLine: /((https?:\/\/)?[a-zA-Z0-9.\-]+\.[a-zA-Z0-9.\-:]*)/,
        // 匹配复杂的同行格式（含有线路关键词和URL）
        complexLineWithUrl: /^(.{0,50}?线路.{0,50}?)\s+((https?:\/\/)?[a-zA-Z0-9.\-]+\.[a-zA-Z0-9.\-:]*)/u,
        standaloneUrl: /^((https?:\/\/)?[a-zA-Z0-9.\-]+\.[a-zA-Z0-9.\-:]*)/,
        port: /(?:https?\s*端口|端口)\s*[|：:]\s*(\d{2,5})/,
    };

    function processUrlMatch(lineInfo) {
        const { title, url: fullUrl } = lineInfo;
        const parsedUrl = parseUrl(fullUrl);
        const hasPort = fullUrl.startsWith('http') 
            ? !!(parsedUrl && parsedUrl.port) 
            : /:\d+$/.test(fullUrl);

        if (hasPort) {
            embyInfo.lines.push({ title, url: fullUrl });
            lastHost = null;
            pendingLineTitle = null;
        } else {
            lastHost = { title, host: fullUrl };
        }
    }

    function addLineFromLastHost(port = '') {
        if (lastHost) {
            const url = port ? `${lastHost.host}:${port}` : lastHost.host;
            embyInfo.lines.push({ title: lastHost.title, url });
            lastHost = null;
        }
        pendingLineTitle = null;
    }

    for (const line of textLines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
            // 空行重置待处理的线路标题
            pendingLineTitle = null;
            continue;
        }

        const usernameMatch = trimmedLine.match(regexPatterns.username);
        const passwordMatch = trimmedLine.match(regexPatterns.password);
        const lineWithUrlMatch = trimmedLine.match(regexPatterns.lineWithUrl);
        const complexLineWithUrlMatch = trimmedLine.match(regexPatterns.complexLineWithUrl);
        const genericUrlMatch = trimmedLine.match(regexPatterns.genericUrl);
        const lineTitleMatch = trimmedLine.match(regexPatterns.lineTitle);
        const urlInLineMatch = trimmedLine.match(regexPatterns.urlInLine);
        const standaloneUrlMatch = trimmedLine.match(regexPatterns.standaloneUrl);
        const portMatch = trimmedLine.match(regexPatterns.port);

        const isLabelLine = !!(lineWithUrlMatch || complexLineWithUrlMatch || genericUrlMatch || usernameMatch || passwordMatch || lineTitleMatch);

        if (lastHost && isLabelLine) {
            if (portMatch) {
                addLineFromLastHost(portMatch[1]);
                continue;
            }
            addLineFromLastHost();
        }

        if (usernameMatch && !embyInfo.username) {
            embyInfo.username = usernameMatch[1];
        }
        if (passwordMatch && !embyInfo.password) {
            embyInfo.password = passwordMatch[1];
        }

        // 优先匹配复杂的同行格式（更完整的描述）
        if (complexLineWithUrlMatch) {
            // 提取线路名称（去除多余的描述文字）
            let label = complexLineWithUrlMatch[1].trim();
            // 简化标题，只保留线路前后的主要关键词
            const simplifiedMatch = label.match(/([\w\d\u4e00-\u9fa5]*\s*线路[\w\d\u4e00-\u9fa5]*)/u);
            if (simplifiedMatch) {
                label = simplifiedMatch[1].trim();
            }
            const fullUrl = complexLineWithUrlMatch[2];
            processUrlMatch({ title: label, url: fullUrl });
        }
        // 其次匹配简单的同行格式
        else if (lineWithUrlMatch) {
            const label = lineWithUrlMatch[1].trim();
            const fullUrl = lineWithUrlMatch[2];
            processUrlMatch({ title: label, url: fullUrl });
        }
        // 其次匹配传统的分隔符格式
        else if (genericUrlMatch) {
            const label = genericUrlMatch[1].trim();
            const fullUrl = genericUrlMatch[2];
            processUrlMatch({ title: label, url: fullUrl });
        }
        // 匹配纯线路标题行（为下一行的URL做准备）
        else if (lineTitleMatch && !standaloneUrlMatch && !urlInLineMatch) {
            pendingLineTitle = lineTitleMatch[1].trim();
        }
        // 处理包含URL的行（优先使用pendingLineTitle）
        else if (urlInLineMatch && pendingLineTitle) {
            processUrlMatch({ title: pendingLineTitle, url: urlInLineMatch[1] });
            pendingLineTitle = null;
        }
        // 匹配单独的URL行
        else if (standaloneUrlMatch) {
            const title = pendingLineTitle || '线路';
            processUrlMatch({ title, url: standaloneUrlMatch[1] });
            pendingLineTitle = null;
        }
        // 处理端口行
        else if (portMatch && lastHost) {
            addLineFromLastHost(portMatch[1]);
        }
    }

    addLineFromLastHost();

    const patterns = {
        blacklist: /\b(wiki|faka|notion|t\.me|telegram|help)\b/i,
        // validUrl: /^(https?:\/\/)([a-zA-Z0-9\-\.]+)+(:\d{1,5})?$/i,
        validUrl: /^(https?:\/\/)[\w\.\-]+(:\d{1,5})?$/i,
        port: /:(\d+)(?:[^\d]|$)/,
        hasProtocol: /^https?:\/\//,
        hasPort: /:\d+$/,
        // httpsPort: /^(?:443|8443)$/
    };

    // 合并标准化和过滤逻辑，减少遍历次数
    embyInfo.lines = embyInfo.lines.reduce((validLines, line) => {
        if (!line.url) return validLines;
        
        let url = line.url.trim();
        
        // 黑名单检查
        if (patterns.blacklist.test(url)) {
            console.log(`黑名单过滤: ${line.url}`);
            return validLines;
        }
        
        try {
            // URL标准化
            if (!patterns.hasProtocol.test(url)) {
                const portMatch = url.match(patterns.port);
                if (portMatch) {
                    const port = portMatch[1];
                    // const protocol = patterns.httpsPort.test(port) ? 'https://' : 'http://';
                    const protocol = (port === '443' || port === '8443') ? 'https://' : 'http://';
                    url = `${protocol}${url}`;
                } else {
                    url = `https://${url}:443`;
                }
            } else {
                // 添加默认端口（如果需要）
                const parsedUrl = parseUrl(url);
                if (parsedUrl && !parsedUrl.port && !patterns.hasPort.test(url)) {
                    const defaultPort = url.startsWith('https://') ? ':443' : ':80';
                    url += defaultPort;
                }
            }
            
            // 验证最终URL格式
            if (patterns.validUrl.test(url)) {
                validLines.push({ ...line, url });
            } else {
                console.log(`格式不符，跳过: ${line.url}`);
            }
        } catch (e) {
            console.log(`URL处理错误: ${line.url}`, e);
        }
        
        return validLines;
    }, []);

    return embyInfo;
}

function processEmbyLines(lines) {
    if (!lines || lines.length === 0) return null;

    function createLineInfo(line, index = 0) {
        const parsedUrl = parseUrl(line.url.trim());
        if (!parsedUrl) return null;
        
        const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80');
        const scheme = parsedUrl.protocol.replace(':', '');
        // const path = parsedUrl.pathname + parsedUrl.search + parsedUrl.hash;
        // 修复路径处理
        let path = parsedUrl.pathname + parsedUrl.search + parsedUrl.hash;
        if (path === '/') path = ''; // 避免根路径的多余斜杠
        
        return {
            index,
            scheme,
            host: parsedUrl.hostname,
            port,
            path,
            title: line.title,
            url: line.url,
            fullAddress: `${scheme}://${parsedUrl.hostname}:${port}${path}`
        };
    }

    const mainInfo = createLineInfo(lines[0]);
    if (!mainInfo) return null;
    
    // 只有当线路标题是通用的"线路"时才改为"主线路"
    if (mainInfo.title === '线路' || mainInfo.title === '当前线路') {
        mainInfo.title = '主线路';
    }
    
    let genericCounter = 1;
    const backupLines = lines.slice(1)
        .map((line, index) => createLineInfo(line, index + 1))
        .filter(Boolean)
        .map(line => {
            if (line.title === '线路') {
                line.title = `备用线路${genericCounter}`;
                line.originalTitle = '线路';
                genericCounter++;
            }
            return line;
        });

    return { main: mainInfo, backup: backupLines };
}

function buildSchemeUrl(baseUrl, params) {
    const paramString = Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
    
    return `${baseUrl}?${paramString}`;
}

function generateForwardSchemeUrl(embyInfo) {
    const processed = processEmbyLines(embyInfo.lines);
    if (!processed) return null;

    const { main, backup } = processed;
    const params = {
        type: 'emby',
        scheme: main.scheme,
        host: main.host,
        port: main.port,
        title: main.title,
        username: embyInfo.username,
        password: embyInfo.password
    };

    // 添加备用线路
    backup.forEach(line => {
        const normalizedUrl = line.url.endsWith('/') ? line.url.slice(0, -1) : line.url;
        params[`line${line.index}`] = normalizedUrl;
        params[`line${line.index}title`] = line.title;
    });

    return buildSchemeUrl('forward://import', params);
}

function generateSenPlayerSchemeUrl(embyInfo) {
    const processed = processEmbyLines(embyInfo.lines);
    if (!processed) return null;

    const { main, backup } = processed;
    const params = {
        type: 'emby',
        title: main.title,
        address: main.fullAddress,
        username: embyInfo.username,
        password: embyInfo.password
    };

    // 添加备用地址
    backup.forEach(line => {
        params[`address${line.index}`] = line.fullAddress;
        params[`address${line.index}name`] = line.title;
    });

    return buildSchemeUrl('senplayer://importserver', params);
}

async function run(configText) {
    const embyInfo = parseEmbyInfo(configText);
    return {
        Forward: generateForwardSchemeUrl(embyInfo),
        SenPlayer: generateSenPlayerSchemeUrl(embyInfo)
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseEmbyInfo, generateForwardSchemeUrl, generateSenPlayerSchemeUrl, run };
}
