// api/process-day.js - V0.7 (支持大量新角色 + 特殊胜利判定)
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });
    const { roomCode } = req.body;

    // 1. 获取数据
    const { data: players } = await supabase.from('players').select('*').eq('room_code', roomCode);
    const { data: votes } = await supabase.from('votes').select('*').eq('room_code', roomCode);
    const { data: room } = await supabase.from('rooms').select('round_state').eq('code', roomCode).single();

    if (!players || !votes || !room) return res.status(500).json({ message: '数据读取失败' });

    let logs = [];
    let playerUpdates = [];
    const currentRoundNum = parseInt(room.round_state.split(' ')[1]) || 1;
    const totalPlayers = players.length; // 总初始人数 (简单起见用当前列表长度近似，严谨应查历史)
    const alivePlayers = players.filter(p => p.is_alive);
    const aliveCount = alivePlayers.length;

    // --- A. 计票逻辑 (核心数学部分) ---
    let voteCounts = {}; 
    players.forEach(p => voteCounts[p.id] = 0);

    // 1. 基础遍历
    votes.forEach(v => {
        if (!v.target_id) return; // 弃票

        const voter = players.find(p => p.id === v.voter_id);
        const target = players.find(p => p.id === v.target_id);

        if (!voter || !voter.is_alive) return;

        // [同盟者] 互投无效
        if (voter.role === '同盟者' && voter.flags?.ally_id === v.target_id) return;
        if (target?.role === '同盟者' && target.flags?.ally_id === v.voter_id) return;

        // [双票使者] 权重为 2
        let weight = 1;
        if (voter.role === '双票使者') weight = 2;

        voteCounts[v.target_id] += weight;
    });

    // 2. [同盟者] 共投检测 (同盟投同一人额外+1)
    // 逻辑：找到所有同盟者，检查他们的盟友是否也投了同一人
    const allies = players.filter(p => p.role === '同盟者' && p.is_alive && p.flags?.ally_id);
    let processedPairs = new Set(); // 防止 A查B加一次，B查A又加一次

    allies.forEach(p1 => {
        const allyId = p1.flags.ally_id;
        // 避免重复处理同一对 (只处理 ID 小的那个人)
        if (p1.id > allyId) return; 

        const p2 = players.find(p => p.id === allyId);
        if (p2 && p2.is_alive) {
            const v1 = votes.find(v => v.voter_id === p1.id);
            const v2 = votes.find(v => v.voter_id === p2.id);
            
            // 如果两人都投了票，且投给同一个目标 (非弃票)
            if (v1?.target_id && v2?.target_id && v1.target_id === v2.target_id) {
                voteCounts[v1.target_id] += 1; // 额外增加 1 票
                // 可选：加个日志提示
                // logs.push({ message: '【同盟者】默契配合，额外造成 1 点票数伤害！', tag: 'PUBLIC' });
            }
        }
    });

    // 3. [减票守护者] & [利他守护者]
    players.forEach(p => {
        // 减票守护者：自带 -1 甲
        if (p.role === '减票守护者' && voteCounts[p.id] > 0) {
            voteCounts[p.id] = Math.max(0, voteCounts[p.id] - 1);
        }
        // 利他守护：无敌
        if (p.flags?.is_protected) {
            voteCounts[p.id] = 0;
        }
    });

    // --- B. 胜利判定 I (投票结算前触发) ---
    let winner = null;
    let winReason = '';

    // [集票胜者] 票数 >= 2/3
    const collector = players.find(p => p.role === '集票胜者' && p.is_alive);
    const threshold = Math.ceil(aliveCount * 2 / 3);
    if (collector && voteCounts[collector.id] >= threshold && voteCounts[collector.id] > 0) {
        winner = collector;
        winReason = '【集票胜者】获得超过 2/3 票数，直接获胜！';
    }

    // --- C. 处决逻辑 ---
    let maxVotes = 0;
    Object.values(voteCounts).forEach(c => { if (c > maxVotes) maxVotes = c; });
    
    // 找出最高票候选人
    const candidates = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVotes).map(Number);
    let eliminatedPlayerId = null;

    if (!winner) {
        if (maxVotes === 0) {
            logs.push({ message: '今日无人投票。', tag: 'PUBLIC' });
        } else if (candidates.length > 1) {
            // === 平票 ===
            const names = candidates.map(id => players.find(p => p.id === id)?.name).join(', ');
            logs.push({ message: `出现平票！${names} 均获得 ${maxVotes} 票。无人出局。`, tag: 'PUBLIC' });

            // [平票赢家]
            const tieWinner = players.find(p => p.role === '平票赢家' && p.is_alive && candidates.includes(p.id));
            if (tieWinner) {
                winner = tieWinner;
                winReason = '【平票赢家】在平局中幸存并获胜！';
            }

            // [平票终结者] (累积计数)
            const tieBreaker = players.find(p => p.role === '平票终结者' && p.is_alive);
            if (tieBreaker) {
                const streak = (tieBreaker.flags?.tie_streak || 0) + 1;
                playerUpdates.push({ ...tieBreaker, flags: { ...tieBreaker.flags, tie_streak: streak } });
                // 胜利条件：连续 a 局 (a = 总人数/3)
                const goal = Math.ceil(totalPlayers / 3);
                if (streak >= goal) {
                    winner = tieBreaker;
                    winReason = `【平票终结者】连续 ${streak} 局见证平局！`;
                }
            }

        } else {
            // === 处决 ===
            eliminatedPlayerId = candidates[0];
            const victim = players.find(p => p.id === eliminatedPlayerId);
            if (victim) {
                // 标记死亡
                playerUpdates.push({ ...victim, is_alive: false, flags: {} });
                logs.push({ message: `玩家【${victim.name}】被处决 (票数: ${maxVotes})。`, tag: 'PUBLIC' });
            }
        }
    }

    // [免票胜者] 判定 (只要自己票数为0且没死)
    const zeroVoter = players.find(p => p.role === '免票胜者' && p.is_alive && p.id !== eliminatedPlayerId);
    if (zeroVoter && !winner) {
        if (voteCounts[zeroVoter.id] === 0) {
            const streak = (zeroVoter.flags?.no_vote_streak || 0) + 1;
            
            // 更新 flags (注意避免覆盖)
            const existing = playerUpdates.find(u => u.id === zeroVoter.id);
            if (existing) existing.flags.no_vote_streak = streak;
            else playerUpdates.push({ ...zeroVoter, flags: { ...zeroVoter.flags, no_vote_streak: streak } });

            const goal = Math.ceil(totalPlayers / 3);
            if (streak >= goal) {
                winner = zeroVoter;
                winReason = `【免票胜者】连续 ${streak} 局完美隐身！`;
            }
        } else {
            // 被投了，重置
            const existing = playerUpdates.find(u => u.id === zeroVoter.id);
            if (existing) existing.flags.no_vote_streak = 0;
            else playerUpdates.push({ ...zeroVoter, flags: { ...zeroVoter.flags, no_vote_streak: 0 } });
        }
    }

    // --- D. 胜利判定 II (死亡触发) ---
    
    // [影子胜者]
    const shadow = players.find(p => p.role === '影子胜者' && p.is_alive);
    // 检查影子目标是否就是刚才死掉的人
    if (shadow && eliminatedPlayerId && shadow.flags?.shadow_target_id === eliminatedPlayerId) {
        winner = shadow;
        winReason = '【影子胜者】的目标已死亡，任务完成！';
    }

    // --- E. 最终结算 & 状态切换 ---
    let nextState = '';
    const finalAliveCount = players.filter(p => p.is_alive && p.id !== eliminatedPlayerId).length;

    if (winner) {
        nextState = 'GAME OVER';
        logs.push({ message: `🏆 游戏结束！${winReason} 获胜者：${winner.name}`, tag: 'PUBLIC' });
    } else {
        // [三人王者]
        const threeKings = players.find(p => p.role === '三人王者' && p.is_alive && p.id !== eliminatedPlayerId);
        
        if (threeKings && finalAliveCount === 3) {
            nextState = 'GAME OVER';
            logs.push({ message: `🎉 场上仅剩 3 人，【三人王者】${threeKings.name} 加冕为王！`, tag: 'PUBLIC' });
        } else if (finalAliveCount <= 2) {
            nextState = 'GAME OVER';
            logs.push({ message: '🚫 存活不足 2 人，游戏结束。', tag: 'PUBLIC' });
        } else {
            // 游戏继续
            nextState = `NIGHT ${currentRoundNum + 1}`;
        }
    }

    // --- 提交数据库 ---
    if (playerUpdates.length > 0) await supabase.from('players').upsert(playerUpdates);
    
    // 清空投票
    await supabase.from('votes').delete().eq('room_code', roomCode); 

    if (logs.length > 0) {
        const logsPayload = logs.map(l => ({ 
            room_code: roomCode, 
            message: l.message, 
            viewer_ids: null, 
            tag: l.tag,
            created_at: new Date().toISOString()
        }));
        await supabase.from('game_logs').insert(logsPayload);
    }

    await supabase.from('rooms').update({ round_state: nextState }).eq('code', roomCode);

    res.status(200).json({ success: true, message: '结算完成' });
}