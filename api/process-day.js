// api/process-day.js - V0.8 (包含影子胜者追魂逻辑 + 15个角色完整判定)
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
    const totalPlayers = players.length; 
    const alivePlayers = players.filter(p => p.is_alive);
    const aliveCount = alivePlayers.length;

    // --- A. 计票逻辑 ---
    let voteCounts = {}; 
    players.forEach(p => voteCounts[p.id] = 0);

    // 1. 基础计票 & 角色权重
    votes.forEach(v => {
        if (!v.target_id) return; 
        const voter = players.find(p => p.id === v.voter_id);
        const target = players.find(p => p.id === v.target_id);
        if (!voter || !voter.is_alive) return;

        // [同盟者] 互投无效
        if (voter.role === '同盟者' && voter.flags?.ally_id === v.target_id) return;
        if (target?.role === '同盟者' && target.flags?.ally_id === v.voter_id) return;

        // [双票使者] 权重2
        let weight = (voter.role === '双票使者') ? 2 : 1;
        voteCounts[v.target_id] += weight;
    });

    // 2. [同盟者] 共投检测 (+1)
    const allies = players.filter(p => p.role === '同盟者' && p.is_alive && p.flags?.ally_id);
    allies.forEach(p1 => {
        if (p1.id > p1.flags.ally_id) return; // 去重
        const p2 = players.find(p => p.id === p1.flags.ally_id);
        if (p2 && p2.is_alive) {
            const v1 = votes.find(v => v.voter_id === p1.id);
            const v2 = votes.find(v => v.voter_id === p2.id);
            if (v1?.target_id && v2?.target_id && v1.target_id === v2.target_id) {
                voteCounts[v1.target_id] += 1; 
            }
        }
    });

    // 3. 防御与减票
    players.forEach(p => {
        if (p.role === '减票守护者' && voteCounts[p.id] > 0) voteCounts[p.id] -= 1;
        if (p.flags?.is_protected) voteCounts[p.id] = 0;
    });

    // --- B. 胜利判定 I (投票结算前触发) ---
    let winner = null;
    let winReason = '';

    // 10. [集票胜者]
    const collector = players.find(p => p.role === '集票胜者' && p.is_alive);
    if (collector && voteCounts[collector.id] >= Math.ceil(aliveCount * 2 / 3) && voteCounts[collector.id] > 0) {
        winner = collector;
        winReason = '【集票胜者】获得超过 2/3 票数，直接获胜！';
    }

    // --- C. 处决逻辑 ---
    let maxVotes = 0;
    Object.values(voteCounts).forEach(c => { if (c > maxVotes) maxVotes = c; });
    const candidates = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVotes).map(Number);
    let eliminatedPlayerId = null;

    if (!winner) {
        if (maxVotes === 0) {
            logs.push({ message: '今日无人投票。', tag: 'PUBLIC' });
        } else if (candidates.length > 1) {
            // === 平票 ===
            const names = candidates.map(id => players.find(p => p.id === id)?.name).join(', ');
            logs.push({ message: `平票！${names} 均获得 ${maxVotes} 票。无人出局。`, tag: 'PUBLIC' });

            // 15. [平票赢家]
            const tieWinner = players.find(p => p.role === '平票赢家' && p.is_alive && candidates.includes(p.id));
            if (tieWinner) { winner = tieWinner; winReason = '【平票赢家】在平局中幸存并获胜！'; }

            // 8. [平票终结者]
            const tieBreaker = players.find(p => p.role === '平票终结者' && p.is_alive);
            if (tieBreaker) {
                const streak = (tieBreaker.flags?.tie_streak || 0) + 1;
                playerUpdates.push({ ...tieBreaker, flags: { ...tieBreaker.flags, tie_streak: streak } });
                if (streak >= Math.ceil(totalPlayers / 3)) { winner = tieBreaker; winReason = `【平票终结者】连续 ${streak} 局平票！`; }
            }
        } else {
            // === 处决 ===
            eliminatedPlayerId = candidates[0];
            const victim = players.find(p => p.id === eliminatedPlayerId);
            if (victim) {
                // 【关键升级】记录死亡时间与类型
                playerUpdates.push({ 
                    ...victim, 
                    is_alive: false, 
                    death_round: currentRoundNum,
                    death_type: 'VOTE',
                    flags: {} 
                });
                logs.push({ message: `玩家【${victim.name}】被处决 (票数: ${maxVotes})。`, tag: 'PUBLIC' });
            }
        }
    }

    // --- D. 状态更新与计数器 (无论是否有人死都要做) ---

    // 14. [票数平衡者] (连续a局得票相同)
    const balancer = players.find(p => p.role === '票数平衡者' && p.is_alive && p.id !== eliminatedPlayerId);
    if (balancer && !winner) {
        const currentVotes = voteCounts[balancer.id];
        const lastVotes = balancer.flags?.last_vote_count;
        let streak = balancer.flags?.balance_streak || 0;

        // 如果不是第一轮，且票数与上一轮相同
        if (lastVotes !== undefined && currentVotes === lastVotes) {
            streak += 1;
        } else {
            streak = 1; // 重置或开始
        }

        // 更新 flags (存这次的票数供明天对比)
        const update = playerUpdates.find(u => u.id === balancer.id) || { ...balancer, flags: { ...balancer.flags } };
        update.flags.last_vote_count = currentVotes;
        update.flags.balance_streak = streak;
        // 如果 update 还没在列表里，加进去
        if (!playerUpdates.find(u => u.id === balancer.id)) playerUpdates.push(update);

        if (streak >= Math.ceil(totalPlayers / 2)) {
            winner = balancer;
            winReason = `【票数平衡者】连续 ${streak} 局得票数保持一致！`;
        }
    }

    // 21. [多选胜者] (连续a局投不同人且人死)
    const multiKiller = players.find(p => p.role === '多选胜者' && p.is_alive && p.id !== eliminatedPlayerId);
    if (multiKiller && !winner) {
        const myVote = votes.find(v => v.voter_id === multiKiller.id);
        const myTargetId = myVote?.target_id;
        
        let streak = multiKiller.flags?.multikill_streak || 0;
        let history = multiKiller.flags?.vote_history || [];

        // 条件1: 必须投了有效票
        // 条件2: 目标必须是今天被处决的人
        // 条件3: 目标必须不在历史记录里
        if (myTargetId && myTargetId === eliminatedPlayerId && !history.includes(myTargetId)) {
            streak += 1;
            history.push(myTargetId);
        } else {
            streak = 0; // 断了，重置
            history = [];
        }

        const update = playerUpdates.find(u => u.id === multiKiller.id) || { ...multiKiller, flags: { ...multiKiller.flags } };
        update.flags.multikill_streak = streak;
        update.flags.vote_history = history;
        if (!playerUpdates.find(u => u.id === multiKiller.id)) playerUpdates.push(update);

        if (streak >= Math.ceil(totalPlayers / 3)) {
            winner = multiKiller;
            winReason = `【多选胜者】连续 ${streak} 局投票处决了不同的玩家！`;
        }
    }

    // 12. [免票胜者]
    const zeroVoter = players.find(p => p.role === '免票胜者' && p.is_alive && p.id !== eliminatedPlayerId);
    if (zeroVoter && !winner) {
        let streak = zeroVoter.flags?.no_vote_streak || 0;
        if (voteCounts[zeroVoter.id] === 0) streak += 1;
        else streak = 0;

        const update = playerUpdates.find(u => u.id === zeroVoter.id) || { ...zeroVoter, flags: { ...zeroVoter.flags } };
        update.flags.no_vote_streak = streak;
        if (!playerUpdates.find(u => u.id === zeroVoter.id)) playerUpdates.push(update);

        if (streak >= Math.ceil(totalPlayers / 3)) { winner = zeroVoter; winReason = `【免票胜者】连续 ${streak} 局零票！`; }
    }

    // --- E. 胜利判定 II (基于死亡历史) ---

    // 13. [影子胜者] (重写版：前后一回合 + 必须被票死)
    // 逻辑：遍历所有影子胜者 (无论死活)，检查条件
    const allShadows = players.filter(p => p.role === '影子胜者');
    
    for (const shadow of allShadows) {
        if (winner) break;

        const targetId = shadow.flags?.shadow_target_id;
        if (!targetId) continue;

        // 获取影子和目标的信息 (可能在 playerUpdates 里更新了，也可能在原始 players 里)
        // 优先看 playerUpdates (因为刚刚可能有人死)，没有再看 players
        const shadowUpdate = playerUpdates.find(u => u.id === shadow.id);
        const targetUpdate = playerUpdates.find(u => u.id === targetId);
        
        const shadowFinal = shadowUpdate || shadow;
        const targetFinal = targetUpdate || players.find(p => p.id === targetId);

        if (!targetFinal) continue;

        // 核心判定:
        // 1. 影子必须是死的 (is_alive=false)
        // 2. 影子必须是被票死的 (death_type='VOTE')
        // 3. 目标必须是死的
        // 4. 两人死亡回合差 <= 1
        
        if (
            shadowFinal.is_alive === false &&
            shadowFinal.death_type === 'VOTE' &&
            targetFinal.is_alive === false &&
            Math.abs((shadowFinal.death_round || 0) - (targetFinal.death_round || 0)) <= 1
        ) {
            winner = shadow; // 这里用原始对象获取名字，因为 update 对象可能不全
            // 即使影子死了，他也能赢
            winReason = `【影子胜者】${shadow.name} 达成同归于尽成就 (被投死且目标在前后一回合内出局)！`;
        }
    }


    // --- F. 最终结算 ---
    let nextState = '';
    const finalAliveCount = players.filter(p => {
        // 检查他是否活着 (排除刚被处决的)
        return p.is_alive && p.id !== eliminatedPlayerId;
    }).length;

    if (winner) {
        nextState = 'GAME OVER';
        logs.push({ message: `🎉 游戏结束！${winReason} 获胜者：${winner.name}`, tag: 'PUBLIC' });
    } else {
        // 11. [三人王者]
        const threeKings = players.find(p => p.role === '三人王者' && p.is_alive && p.id !== eliminatedPlayerId);
        
        if (threeKings && finalAliveCount === 3) {
            nextState = 'GAME OVER';
            logs.push({ message: `🎉 场上仅剩 3 人，【三人王者】${threeKings.name} 加冕为王！`, tag: 'PUBLIC' });
        } else if (finalAliveCount <= 2) {
            nextState = 'GAME OVER';
            logs.push({ message: '🚫 存活不足 2 人，游戏结束。', tag: 'PUBLIC' });
        } else {
            nextState = `NIGHT ${currentRoundNum + 1}`;
        }
    }

    // 提交
    if (playerUpdates.length > 0) await supabase.from('players').upsert(playerUpdates);
    await supabase.from('votes').delete().eq('room_code', roomCode); 
    if (logs.length > 0) {
        const logsPayload = logs.map(l => ({ room_code: roomCode, message: l.message, viewer_ids: null, tag: l.tag, created_at: new Date().toISOString() }));
        await supabase.from('game_logs').insert(logsPayload);
    }
    await supabase.from('rooms').update({ round_state: nextState }).eq('code', roomCode);

    res.status(200).json({ success: true, message: '结算完成' });
}